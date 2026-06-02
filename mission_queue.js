// mission_queue.js
// Coda di missioni con priorità per l'agente LLM.
//
// COMPORTAMENTO:
//   1. Quando arriva una missione → la valuta (mission_evaluator) e la mette
//      in coda. Le trappole vengono scartate subito.
//   2. Dopo un breve BUFFER (per raccogliere missioni che arrivano in burst)
//      la coda viene scandita: la missione di priorità maggiore viene eseguita.
//   3. Mentre eseguo una missione X, se ne arriva una Y con priorità
//      ≥ X.priority × INTERRUPT_FACTOR, X viene interrotta e parte Y.
//      Altrimenti Y resta in coda e verrà ripresa dopo.
//   4. Niente expiry: le missioni restano in coda finché non vengono eseguite
//      o scartate per invalidità.
//   5. Prima di eseguire una missione, controllo "isStillValid": se è una
//      missione di pickup su coordinate dove non c'è più un pacco
//      (probabilmente l'ha preso un altro agente) → scartata.

import { evaluateMission } from './mission_evaluator.js';

const BUFFER_MS        = 500;   // raccolta-missioni prima di scegliere
const INTERRUPT_FACTOR = 2.0;   // nuovo deve essere ≥ 2× la corrente per interrompere
const TICK_MS          = 100;   // frequenza dello scheduler

// Parole inglesi che indicano "raccogli un pacco" — usate dal check di validità
const PICKUP_KEYWORDS = /\b(pick\s*up|pickup|take|grab|collect|fetch|retrieve)\b/i;


// ─────────────────────────────────────────────────────────────────────────────
// Stato del modulo
// ─────────────────────────────────────────────────────────────────────────────

let _queue   = [];          // {text, senderId, priority, addedAt, verdict}
let _running = null;        // {text, senderId, priority, controller}
let _ticker  = null;

let _beliefs       = null;
let _runMissionFn  = null;  // (text, ctx, senderId, signal) → Promise


// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object}   beliefs
 * @param {Function} runMission  funzione che esegue una missione.
 *                               firma: (text, senderId, signal) => Promise
 */
export function initQueue({ beliefs, runMission }) {
    _beliefs       = beliefs;
    _runMissionFn  = runMission;
    if (_ticker) clearInterval(_ticker);
    _ticker = setInterval(tick, TICK_MS);
}


// ─────────────────────────────────────────────────────────────────────────────
// ENQUEUE  — chiamato dall'handler onMsg con il testo della missione
// ─────────────────────────────────────────────────────────────────────────────

export function enqueue(text, senderId) {
    const verdict = evaluateMission(text, _beliefs);
    if (!verdict.worth) {
        console.log(`[QUEUE] scartata "${text}" — ${verdict.reason}`);
        return;
    }

    const entry = {
        text, senderId,
        priority: verdict.priority,
        verdict,
        addedAt: Date.now(),
    };
    _queue.push(entry);
    console.log(`[QUEUE] +"${text}" (pri=${verdict.priority.toFixed(2)}) — ${verdict.reason}`);

    // Politica di interruzione: se sto eseguendo e il nuovo arrivato è MOLTO
    // più conveniente (≥ INTERRUPT_FACTOR×), interrompo la corrente.
    if (_running && entry.priority >= _running.priority * INTERRUPT_FACTOR) {
        console.log(`[QUEUE] interrompo corrente (pri=${_running.priority.toFixed(2)}) per nuova (pri=${entry.priority.toFixed(2)})`);
        _running.controller.abort();
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// VALIDITÀ — controllo conservativo, attivo solo per casi OVVII
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Restituisce true se la missione sembra ancora eseguibile.
 * Conservativo: in caso di dubbio ritorna sempre `true`.
 */
function isStillValid(mission, beliefs) {
    const text = mission.text || '';
    const m = text.match(/\((\d+)\s*,\s*(\d+)\)/);
    if (!m) return true;             // niente coord → niente da verificare

    const x = Number(m[1]);
    const y = Number(m[2]);

    // Caso ovvio: pickup-like + coordinate → deve esserci un pacco libero lì.
    // Tutto il resto (move, drop, generico) → considerato sempre valido.
    if (PICKUP_KEYWORDS.test(text)) {
        const parcels = beliefs?.parcels;
        if (!parcels) return true;
        for (const p of parcels.values()) {
            if (Math.round(p.x) === x && Math.round(p.y) === y && !p.carriedBy) {
                return true;
            }
        }
        return false;                // nessun pacco lì → invalida
    }

    return true;
}


// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULER — gira ogni TICK_MS
// ─────────────────────────────────────────────────────────────────────────────

function tick() {
    if (_running)          return;     // sto già eseguendo
    if (_queue.length === 0) return;   // nulla da fare

    // Buffer: aspetto che la più vecchia sia in coda da almeno BUFFER_MS,
    // così se arriva un burst di missioni le valuto tutte insieme.
    const oldest = _queue.reduce((a, b) => a.addedAt <= b.addedAt ? a : b);
    if (Date.now() - oldest.addedAt < BUFFER_MS) return;

    // Scarta missioni non più valide
    _queue = _queue.filter(m => {
        if (!isStillValid(m, _beliefs)) {
            console.log(`[QUEUE] scartata (non più valida): "${m.text}"`);
            return false;
        }
        return true;
    });
    if (_queue.length === 0) return;

    // Scegli la migliore (priorità più alta; a parità, la più vecchia)
    _queue.sort((a, b) => b.priority - a.priority || a.addedAt - b.addedAt);
    const best = _queue.shift();
    runOne(best);
}


function runOne(mission) {
    const controller = new AbortController();
    _running = { ...mission, controller };

    console.log(`[QUEUE] eseguo "${mission.text}" (pri=${mission.priority.toFixed(2)})`);

    Promise.resolve()
        .then(() => _runMissionFn(mission.text, mission.senderId, controller.signal))
        .catch(err => console.warn(`[QUEUE] errore esecuzione: ${err?.message ?? err}`))
        .finally(() => { _running = null; });
}


// ─────────────────────────────────────────────────────────────────────────────
// API DI DEBUG
// ─────────────────────────────────────────────────────────────────────────────

export function queueState() {
    return {
        running: _running ? {
            text: _running.text, priority: _running.priority,
        } : null,
        pending: _queue.map(m => ({
            text: m.text, priority: m.priority, ageMs: Date.now() - m.addedAt,
        })),
    };
}
