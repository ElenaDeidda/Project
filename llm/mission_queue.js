// mission_queue.js
// Coda di missioni con priorita per l'agente LLM.
//
// Flusso: valuta + accoda -> dopo un BUFFER esegue la priorita maggiore -> una
// missione molto piu conveniente (>= INTERRUPT_FACTOR×) interrompe la corrente.
// Niente expiry; prima di eseguire, isStillValid scarta i pickup senza pacco.

import { evaluateMission } from './mission_evaluator.js';

const BUFFER_MS        = 500;   // raccolta-missioni prima di scegliere
const INTERRUPT_FACTOR = 2.0;   // nuovo deve essere >= 2× la corrente per interrompere
const TICK_MS          = 100;   // frequenza dello scheduler

// Parole inglesi che indicano "raccogli un pacco" - usate dal check di validita
const PICKUP_KEYWORDS = /\b(pick\s*up|pickup|take|grab|collect|fetch|retrieve)\b/i;


// ─── Stato del modulo ────────────────────────────────────────────────────────

let _queue   = [];          // {text, senderId, priority, addedAt, verdict}
let _running = null;        // {text, senderId, priority, controller}
let _ticker  = null;

let _beliefs       = null;
let _runMissionFn  = null;  // (text, senderId, signal) -> Promise
let _bdiPause      = () => {};
let _bdiResume     = () => {};


// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object}   beliefs
 * @param {Function} runMission  funzione che esegue una missione.
 *                               firma: (text, senderId, signal) => Promise
 * @param {Function} [bdiPause]  chiamato PRIMA di eseguire una mission
 *                               (silenzia il loop BDI dell'LLM agent)
 * @param {Function} [bdiResume] chiamato DOPO che la mission e finita
 */
export function initQueue({ beliefs, runMission, bdiPause, bdiResume }) {
    _beliefs       = beliefs;
    _runMissionFn  = runMission;
    if (typeof bdiPause  === 'function') _bdiPause  = bdiPause;
    if (typeof bdiResume === 'function') _bdiResume = bdiResume;
    if (_ticker) clearInterval(_ticker);
    _ticker = setInterval(tick, TICK_MS);
}


// ─────────────────────────────────────────────────────────────────────────────
// ENQUEUE  - chiamato dall'handler onMsg con il testo della missione
// ─────────────────────────────────────────────────────────────────────────────

export function enqueue(text, senderId) {
    const verdict = evaluateMission(text, _beliefs);
    if (!verdict.worth) {
        console.log(`[QUEUE] scartata "${text}" - ${verdict.reason}`);
        return;
    }

    // Damping per carico: se i pacchi trasportati valgono piu della mission,
    // abbasso la priorita (meglio consegnare prima). Solo per mission normali
    // positive, mai per le urgenti.
    let priority = verdict.priority;
    let reasonExtra = '';
    if (!verdict.urgent && verdict.reward != null && verdict.reward > 0
        && _beliefs?.carriedParcels?.length > 0) {
        const carriedValue = _beliefs.carriedParcels
            .reduce((sum, p) => sum + (p.reward || 0), 0);
        if (carriedValue > verdict.reward) {
            const ratio = verdict.reward / Math.max(1, carriedValue);
            const newPri = priority * ratio;
            reasonExtra = ` | abbasso pri (porto ${Math.round(carriedValue)}pt > ${verdict.reward}pt mission): ${priority.toFixed(2)} -> ${newPri.toFixed(2)}`;
            priority = newPri;
        }
    }

    const entry = {
        text, senderId,
        priority,
        urgent: !!verdict.urgent,
        verdict,
        addedAt: Date.now(),
    };
    _queue.push(entry);
    console.log(`[QUEUE] +"${text}" (pri=${priority.toFixed(2)}${entry.urgent ? ', URGENTE' : ''}) - ${verdict.reason}${reasonExtra}`);

    // Interruzione: una mission URGENTE (regola/penalita) interrompe subito la
    // corrente - a meno che la corrente sia a sua volta urgente (non lasciamo
    // una regola installata a meta). Le mission normali interrompono solo se
    // MOLTO piu convenienti (>= INTERRUPT_FACTOR×).
    const canInterrupt = _running && !_running.urgent &&
        (entry.urgent || entry.priority >= _running.priority * INTERRUPT_FACTOR);
    if (canInterrupt) {
        console.log(`[QUEUE] interrompo corrente (pri=${_running.priority.toFixed(2)}) per nuova (pri=${entry.priority.toFixed(2)}${entry.urgent ? ', URGENTE' : ''})`);
        _running.controller.abort();
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// VALIDITA - controllo conservativo, attivo solo per casi OVVII
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Restituisce true se la missione sembra ancora eseguibile.
 * Conservativo: in caso di dubbio ritorna sempre `true`.
 */
function isStillValid(mission, beliefs) {
    const text = mission.text || '';
    const m = text.match(/\((\d+)\s*,\s*(\d+)\)/);
    if (!m) return true;             // niente coord -> niente da verificare

    const x = Number(m[1]);
    const y = Number(m[2]);

    // Caso ovvio: pickup-like + coordinate -> deve esserci un pacco libero li.
    // Tutto il resto (move, drop, generico) -> considerato sempre valido.
    if (PICKUP_KEYWORDS.test(text)) {
        const parcels = beliefs?.parcels;
        if (!parcels) return true;
        for (const p of parcels.values()) {
            if (Math.round(p.x) === x && Math.round(p.y) === y && !p.carriedBy) {
                return true;
            }
        }
        return false;                // nessun pacco li -> invalida
    }

    return true;
}


// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULER - gira ogni TICK_MS
// ─────────────────────────────────────────────────────────────────────────────

function tick() {
    if (_running)          return;     // sto gia eseguendo
    if (_queue.length === 0) return;   // nulla da fare

    // Buffer: aspetto che la piu vecchia sia in coda da almeno BUFFER_MS,
    // cosi se arriva un burst di missioni le valuto tutte insieme.
    const oldest = _queue.reduce((a, b) => a.addedAt <= b.addedAt ? a : b);
    if (Date.now() - oldest.addedAt < BUFFER_MS) return;

    // Scarta missioni non piu valide
    _queue = _queue.filter(m => {
        if (!isStillValid(m, _beliefs)) {
            console.log(`[QUEUE] scartata (non piu valida): "${m.text}"`);
            return false;
        }
        return true;
    });
    if (_queue.length === 0) return;

    // Scegli la migliore: prima le URGENTI (regole/penalita), poi per priorita
    // (magnitudine), a parita la piu vecchia.
    _queue.sort((a, b) =>
        (b.urgent === true) - (a.urgent === true) ||
        b.priority - a.priority ||
        a.addedAt - b.addedAt);
    const best = _queue.shift();
    runOne(best);
}


function runOne(mission) {
    const controller = new AbortController();
    _running = { ...mission, controller };

    const startedAt = Date.now();
    console.log(`[QUEUE] > START "${mission.text}" (pri=${mission.priority.toFixed(2)}) - coda restante: ${_queue.length}`);
    _bdiPause();   // silenzia il loop BDI dell'LLM agent durante la mission

    Promise.resolve()
        .then(() => _runMissionFn(mission.text, mission.senderId, controller.signal))
        .catch(err => console.warn(`[QUEUE] [WARN] errore esecuzione: ${err?.message ?? err}`))
        .finally(() => {
            const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
            console.log(`[QUEUE] [END] END   "${mission.text}" - durata ${elapsed}s - coda restante: ${_queue.length}`);
            _running = null;
            _bdiResume();   // il BDI riprende a giocare normalmente
        });
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
