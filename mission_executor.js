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
    if (type === 'move' && verdict.level === 1 && (beliefs.carriedParcels?.length ?? 0) > 0) {
        const d = nearestDelivery(beliefs);
        if (d) {
            log(`porto ${beliefs.carriedParcels.length} pacchi → prima consegno a (${d.x},${d.y})`);
            const r = await goTo(d, ctx, signal);           // opportunistic: consegna all'arrivo
            if (r === 'stopped' || aborted(signal)) return null;
            if (r === 'failed') log(`delivery irraggiungibile, procedo con la task`);
        }
    }
    if (aborted(signal)) return null;

    if (type === 'move') {
        if (!target) throw new Error('move senza target risolto');
        const r = await goTo(target, ctx, signal);
        if (r === 'stopped') return null;
        if (r !== 'reached') throw new Error(`(${target.x},${target.y}) irraggiungibile`);
        return `arrivato a (${target.x},${target.y})`;
    }

    if (type === 'pickup') {
        // Target dal parser, o il pacco libero più vicino ADESSO (la situazione
        // può essere cambiata dalla messa in coda).
        const dest = target ?? nearestFreeParcel(beliefs);
        if (!dest) throw new Error('nessun pacco da raccogliere in vista: rinuncio');
        const r = await goTo(dest, ctx, signal);            // opportunistic raccoglie già
        if (r === 'stopped') return null;
        if (r !== 'reached') throw new Error(`pacco a (${dest.x},${dest.y}) irraggiungibile`);
        await socket.emitPickup();                          // doppia sicurezza
        return `raccolto pacco a (${dest.x},${dest.y})`;
    }

    if (type === 'drop') {
        if (!target) throw new Error('drop senza target risolto');

        // Mi serve almeno un pacco: se non ne porto, prima ne raccolgo uno.
        if ((beliefs.carriedParcels?.length ?? 0) === 0) {
            const p = nearestFreeParcel(beliefs);
            if (!p) throw new Error('drop richiesto ma nessun pacco in mano né in vista: rinuncio');
            log(`niente in mano → raccolgo il pacco a (${Math.round(p.x)},${Math.round(p.y)})`);
            const r1 = await goTo(p, ctx, signal);
            if (r1 === 'stopped') return null;
            if (r1 !== 'reached') throw new Error('pacco da raccogliere irraggiungibile');
            await socket.emitPickup();
        }
        if (aborted(signal)) return null;

        // opportunistic=false: NON devo consegnare il carico passando per caso
        // sopra una delivery — il pacco va depositato sulla tile richiesta.
        const r2 = await goTo(target, ctx, signal, { opportunistic: false });
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
