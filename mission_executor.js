// mission_executor.js
// ─────────────────────────────────────────────────────────────────────────────
// ESECUZIONE DETERMINISTICA delle missioni già "compilate" dal parser.
// Sostituisce il loop ReAct per question/action/rule:
//   - action  → ZERO chiamate LLM: il target è già risolto, si naviga e basta
//   - rule    → ZERO chiamate LLM: la regola JSON viene installata direttamente
//   - question→ 0 chiamate per i calcoli (evalSafe), 1 sola per le domande
//               di conoscenza ("capital of Italy")
// Il ReAct resta solo per il coordinamento L3 (pezzo 4).
//
// Politiche (decise con la strategia v2):
//   - "prima consegno": SOLO per le azioni L1 di tipo 'move'. Le regole L2 si
//     installano in un istante (non muovono il corpo) e i pacchi già in mano
//     possono essere un VANTAGGIO (es. bonus_delivery: li porto già lì).
//   - meglio rinunciare che improvvisare: se manca un pezzo (target nullo,
//     nessun pacco da droppare in vista) la missione finisce lì, niente giri
//     "creativi".
//   - abort pulito: l'AbortSignal della coda viene passato dentro navigateTo
//     (shouldStop), quindi una missione interrotta smette di camminare SUBITO.
// ─────────────────────────────────────────────────────────────────────────────

import { callModel } from './llm_client.js';
import { evalSafe } from './mission_parser.js';
import { installRule } from './rules_engine.js';
import { reachableDistances } from './moves.js';

// ── helper geometrici sui beliefs ────────────────────────────────────────────

function manhattan(a, b) {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function nearestDelivery(beliefs) {
    const dps = beliefs.deliveryPoints ?? [];
    if (dps.length === 0) return null;
    return dps.reduce((best, d) =>
        manhattan(d, beliefs.me) < manhattan(best, beliefs.me) ? d : best);
}

function nearestFreeParcel(beliefs) {
    const free = [...(beliefs.parcels?.values() ?? [])].filter(p => !p.carriedBy);
    if (free.length === 0) return null;
    return free.reduce((best, p) =>
        manhattan(p, beliefs.me) < manhattan(best, beliefs.me) ? p : best);
}

// Miglior punto d'osservazione per TROVARE pacchi: spawn tile con più
// visibilità, vicina a me. (Stessa euristica del rules_engine.)
function bestSpawnTile(beliefs) {
    const spawnVis = beliefs.spawnVisibility ?? new Map();
    if (spawnVis.size === 0) return null;
    let best = null, bestScore = -Infinity;
    for (const [key, vis] of spawnVis.entries()) {
        const [x, y] = key.split('_').map(Number);
        const score = vis * 10 - manhattan({ x, y }, beliefs.me);
        if (score > bestScore) { best = { x, y }; bestScore = score; }
    }
    return best;
}

// Procura un pacco quando non ne porto e non ne vedo: vado su una spawn tile
// ad alta visibilità e aspetto/cerco finché non ne compare uno (con timeout).
// È il comportamento che aveva il vecchio agente LLM via tool, qui reso
// deterministico. Ritorna 'got' | 'stopped' | 'timeout'.
const PARCEL_HUNT_MS    = 20_000;   // tempo massimo a caccia di un pacco
const PARCEL_POLL_MS    = 600;      // ogni quanto ricontrollo i beliefs
async function acquireParcel(ctx, signal, log) {
    const { beliefs, socket } = ctx;
    const deadline = Date.now() + PARCEL_HUNT_MS;

    while (Date.now() < deadline) {
        if (aborted(signal)) return 'stopped';

        const p = nearestFreeParcel(beliefs);
        if (p) {
            log(`pacco avvistato a (${Math.round(p.x)},${Math.round(p.y)}) → vado a raccoglierlo`);
            const r = await goToRobust(p, ctx, signal);
            if (r === 'stopped') return 'stopped';
            if (r === 'reached') {
                await socket.emitPickup();
                if ((beliefs.carriedParcels?.length ?? 0) > 0) return 'got';
            }
            continue;   // pacco sparito/preso da altri → riprovo
        }

        // Niente in vista: vado su una spawn tile a fare da vedetta.
        const spot = bestSpawnTile(beliefs);
        if (spot && manhattan(spot, beliefs.me) > 0) {
            log(`nessun pacco in vista → presidio la spawn tile (${spot.x},${spot.y}) in attesa`);
            const r = await goToRobust(spot, ctx, signal);
            if (r === 'stopped') return 'stopped';
        } else {
            await sleep(PARCEL_POLL_MS);   // già sulla vedetta → aspetto lo spawn
        }
    }
    return 'timeout';
}

// Navigazione con abort: il signal della coda diventa lo shouldStop di
// navigateTo → l'interruzione ferma l'agente al passo successivo, non a fine
// percorso come faceva il ReAct.
async function goTo(target, ctx, signal, { opportunistic = true } = {}) {
    const { beliefs, socket, deps } = ctx;
    return await deps.navigateTo(
        beliefs.me, { x: target.x, y: target.y }, socket, beliefs.mapTiles,
        () => signal?.aborted === true,
        3, opportunistic,
    );
}

function aborted(signal) { return signal?.aborted === true; }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Distanze REALI di percorso (BFS) da dove sono, IGNORANDO gli agenti:
// distingue "irraggiungibile per sempre" (muri → inutile insistere) da
// "bloccato in questo momento" (nemico di passaggio → riprovare paga).
function pathDistances(ctx) {
    const { beliefs } = ctx;
    return reachableDistances(beliefs.me, beliefs.mapTiles, null, beliefs.isDirectionalMap);
}

// navigateTo fallisce SUBITO se un nemico tappa il corridoio. Il BDI non se
// ne accorge perché ritenta ogni 200ms; le missioni devono fare lo stesso:
// qualche tentativo con pausa prima di arrendersi (i nemici si spostano).
const NAV_RETRIES        = 3;
const NAV_RETRY_PAUSE_MS = 1500;

async function goToRobust(target, ctx, signal, opts = {}) {
    const retries = opts.retries ?? NAV_RETRIES;
    for (let i = 1; i <= retries; i++) {
        if (aborted(signal)) return 'stopped';
        const r = await goTo(target, ctx, signal, opts);
        if (r !== 'failed') return r;          // 'reached' o 'stopped'
        if (i < retries) {
            console.log(`[EXEC] percorso verso (${target.x},${target.y}) bloccato (probabile agente di passaggio) — riprovo tra ${NAV_RETRY_PAUSE_MS / 1000}s (${i}/${retries})`);
            await sleep(NAV_RETRY_PAUSE_MS);
        }
    }
    return 'failed';
}


// ── QUESTION ─────────────────────────────────────────────────────────────────
// Calcoli → evalSafe (zero LLM, zero errori "a memoria").
// Conoscenza → 1 chiamata LLM secca. La risposta va al MITTENTE via emitSay.

const CALC_RE = /(?:calculate|calcola|compute|how\s+much\s+is|quanto\s+fa)\s*:?\s*([0-9+\-*/().\s]+)\s*\??\s*$/i;

async function execQuestion(text, verdict, ctx) {
    const { socket } = ctx;
    const question = verdict.question ?? text;

    let answer = null;
    const calc = String(question).match(CALC_RE) ?? String(text).match(CALC_RE);
    if (calc) {
        try { answer = String(evalSafe(calc[1])); }
        catch { /* non era un'espressione valida → si prova con l'LLM */ }
    }
    if (answer === null) {
        answer = (await callModel([
            { role: 'system', content: 'Answer the question concisely. Reply with ONLY the answer (a word, a number or a short phrase). No explanations.' },
            { role: 'user',   content: question },
        ], { temperature: 0 })).trim();
    }

    const to = ctx.lastSender;
    if (!to) throw new Error('nessun mittente a cui rispondere');
    socket.emitSay(to, { type: 'mission_answer', answer });
    return `risposto "${answer}" a ${to}`;
}


// ── RULE ─────────────────────────────────────────────────────────────────────
// Delega a rules_engine.installRule, che oltre a salvare la regola applica i
// side-effects immediati (es. forbidden_tile → la tile diventa un MURO in
// beliefs.mapTiles, così il pathfinding la evita anche come destinazione).

function execRule(verdict, ctx) {
    const rules = ctx.deps?.activeRules;
    if (!rules) throw new Error('activeRules non disponibile');
    return installRule(verdict.rule, rules, ctx.beliefs);
}


// ── ACTION ───────────────────────────────────────────────────────────────────

async function execAction(text, verdict, ctx, signal) {
    const { socket, beliefs } = ctx;
    const type   = verdict.action?.type ?? 'move';
    const target = verdict.target;
    const log    = (m) => console.log(`[EXEC] ${m}`);

    // "Prima consegno": SOLO L1 move con pacchi in mano (per drop i pacchi
    // SERVONO; per pickup la deviazione di solito non vale la pena).
    // La delivery si sceglie per distanza REALE di percorso (non in linea
    // d'aria) e solo tra quelle raggiungibili in questo momento.
    if (type === 'move' && verdict.level === 1 && (beliefs.carriedParcels?.length ?? 0) > 0) {
        const dists = pathDistances(ctx);
        const dps = (beliefs.deliveryPoints ?? [])
            .filter(d => dists.has(`${d.x}_${d.y}`))
            .sort((a, b) => dists.get(`${a.x}_${a.y}`) - dists.get(`${b.x}_${b.y}`));
        if (dps.length === 0) {
            log(`porto ${beliefs.carriedParcels.length} pacchi ma nessuna delivery raggiungibile ora → salto la consegna preventiva`);
        } else {
            const d = dps[0];
            log(`porto ${beliefs.carriedParcels.length} pacchi → prima consegno a (${d.x},${d.y}) [${dists.get(`${d.x}_${d.y}`)} passi]`);
            const r = await goToRobust(d, ctx, signal);     // opportunistic: consegna all'arrivo
            if (r === 'stopped' || aborted(signal)) return null;
            if (r === 'failed') log(`delivery bloccata, procedo con la task`);
        }
    }
    if (aborted(signal)) return null;

    if (type === 'move') {
        // Il parser fornisce target + candidati di riserva (missioni "one of").
        // Qui si separano i candidati in:
        //   - zone chiuse (irraggiungibili anche IGNORANDO i nemici) → scartati
        //   - raggiungibili → tentati in ordine di distanza reale, con retry
        //     (un fallimento di A* di solito è un nemico di passaggio)
        const all = [target, ...(verdict.candidates ?? [])].filter(Boolean);
        if (all.length === 0) throw new Error('move senza target risolto');

        const dists  = pathDistances(ctx);
        const open   = [], closed = [];
        for (const t of all) (dists.has(`${t.x}_${t.y}`) ? open : closed).push(t);
        if (closed.length) {
            log(`candidati in zone chiuse della mappa (muri, non nemici): ${closed.map(t => `(${t.x},${t.y})`).join(' ')} → scartati`);
        }
        if (open.length === 0) {
            throw new Error(`nessun candidato raggiungibile: ${closed.length} in zone chiuse della mappa`);
        }
        open.sort((a, b) => dists.get(`${a.x}_${a.y}`) - dists.get(`${b.x}_${b.y}`));
        log(`ordine di tentativo (distanza reale): ${open.map(t => `(${t.x},${t.y})=${dists.get(`${t.x}_${t.y}`)} passi`).join('  ')}`);

        for (let i = 0; i < open.length; i++) {
            const t = open[i];
            if (i > 0) log(`provo il candidato successivo: (${t.x},${t.y})`);
            const r = await goToRobust(t, ctx, signal);
            if (r === 'stopped') return null;
            if (r === 'reached') return `arrivato a (${t.x},${t.y})`;
            log(`(${t.x},${t.y}) resta bloccato dopo ${NAV_RETRIES} tentativi`);
        }
        throw new Error(`tutti i ${open.length} candidati raggiungibili restano bloccati da agenti: rinuncio`);
    }

    if (type === 'pickup') {
        // Target dal parser, o il pacco libero più vicino ADESSO (la situazione
        // può essere cambiata dalla messa in coda).
        const dest = target ?? nearestFreeParcel(beliefs);
        if (!dest) throw new Error('nessun pacco da raccogliere in vista: rinuncio');
        const r = await goToRobust(dest, ctx, signal);      // opportunistic raccoglie già
        if (r === 'stopped') return null;
        if (r !== 'reached') throw new Error(`pacco a (${dest.x},${dest.y}) irraggiungibile`);
        await socket.emitPickup();                          // doppia sicurezza
        return `raccolto pacco a (${dest.x},${dest.y})`;
    }

    if (type === 'drop') {
        if (!target) throw new Error('drop senza target risolto');

        // Mi serve almeno un pacco. Se non ne porto, lo vado a procurare:
        // un pacco in vista lo raccolgo subito, altrimenti presidio una spawn
        // tile e aspetto che ne compaia uno (come il vecchio agente LLM).
        if ((beliefs.carriedParcels?.length ?? 0) === 0) {
            log(`la missione chiede di consegnare a (${target.x},${target.y}) ma non porto nulla → procuro un pacco`);
            const got = await acquireParcel(ctx, signal, log);
            if (got === 'stopped') return null;
            if (got === 'timeout') throw new Error(`nessun pacco trovato in ${PARCEL_HUNT_MS / 1000}s: rinuncio`);
        }
        if (aborted(signal)) return null;

        // opportunistic=false: NON devo consegnare il carico passando per caso
        // sopra una delivery — il pacco va depositato sulla tile richiesta.
        const r2 = await goToRobust(target, ctx, signal, { opportunistic: false });
        if (r2 === 'stopped') return null;
        if (r2 !== 'reached') throw new Error(`(${target.x},${target.y}) irraggiungibile`);

        // Depongo UN pacco (il meno prezioso): la missione chiede "a package",
        // il resto del carico resta per la consegna normale del BDI.
        const carried = [...(beliefs.carriedParcels ?? [])]
            .sort((a, b) => (a.reward ?? 0) - (b.reward ?? 0));
        if (carried.length === 0) throw new Error('arrivato ma senza pacchi in mano');
        const dropped = await socket.emitPutdown([carried[0].id]);
        if (dropped && dropped.length > 0) {
            beliefs.carriedParcels = beliefs.carriedParcels.filter(p => p.id !== carried[0].id);
            beliefs.carrying       = beliefs.carriedParcels.length > 0;
        }
        return `depositato pacco ${carried[0].id} a (${target.x},${target.y})`;
    }

    throw new Error(`tipo di azione sconosciuto: ${type}`);
}


// ── ENTRY POINT ──────────────────────────────────────────────────────────────

/**
 * Esegue una missione usando SOLO il verdict del parser (niente ReAct).
 * @returns {Promise<string|null>} riassunto per i log, o null se interrotta
 * @throws  se la missione non è eseguibile → la queue logga e si passa oltre
 *          (politica: meglio rinunciare che improvvisare)
 */
export async function executeVerdict(text, verdict, ctx, signal) {
    const t0 = Date.now();
    let result;
    switch (verdict.kind) {
        case 'question': result = await execQuestion(text, verdict, ctx);        break;
        case 'rule':     result = execRule(verdict, ctx);                        break;
        case 'action':   result = await execAction(text, verdict, ctx, signal);  break;
        default: throw new Error(`kind non gestito dall'executor: ${verdict.kind}`);
    }
    if (result !== null) {
        console.log(`[EXEC] ✔ "${text}" → ${result} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }
    return result;
}
