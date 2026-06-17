// llm_executor.js
// FASE 2: primitive di esecuzione DETERMINISTICHE (nessuna chiamata LLM).
// Navigazione interrompibile, acquire persistente del pacco ed esecuzione di un
// singolo step del piano traducendolo in tool call.

import {
    nearestVisibleParcel, nearestDelivery, rankedSpawnTiles, acquireWaitMs,
    ACQUIRE_POLL_MS, ACQUIRE_MAX_MS,
} from './world_state.js';
import { makeTools } from './llm_tools.js';
import { normalizeAction, isResultPlaceholder, parseCoords } from './llm_parsers.js';

// Navigazione interrompibile (shouldStop legato al signal di abort). Ritorna
// true SOLO se e davvero arrivato a (x,y) (riusa l'idea di verifica del tool).
async function navigateInterruptible(ctx, x, y, signal) {
    const { socket, beliefs, deps } = ctx;
    const res = await deps.navigateTo(
        beliefs.me, { x, y }, socket, beliefs.mapTiles, () => signal?.aborted === true
    );
    const here = { x: Math.round(beliefs.me.x), y: Math.round(beliefs.me.y) };
    return res === 'reached' && here.x === x && here.y === y;
}

// Sleep che si risveglia SUBITO se arriva l'abort. Ritorna 'aborted' | 'timeout'.
function abortableSleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted) return resolve('aborted');
        const t = setTimeout(() => { cleanup(); resolve('timeout'); }, ms);
        const onAbort = () => { cleanup(); resolve('aborted'); };
        function cleanup() {
            clearTimeout(t);
            signal?.removeEventListener?.('abort', onAbort);
        }
        signal?.addEventListener?.('abort', onAbort, { once: true });
    });
}

/**
 * ACQUIRE PERSISTENTE (deterministico, NO LLM): assicura di avere un pacco a
 * bordo. Cicla {prendi il visibile piu vicino; se non c'e, vai sulla prossima
 * spawn tile e ASPETTA che ne compaia uno, ruotando le tile} finche non porta
 * un pacco. Esce solo su successo o su abort (o sul tetto ACQUIRE_MAX_MS se >0).
 * @returns {Promise<{success:boolean, outcome?:string, error?:string}>}
 */
async function acquireParcelPersistent(ctx, signal) {
    const beliefs   = ctx.beliefs;
    const tag       = '[LLM-ACQUIRE]';
    const carrying  = () => (beliefs.carriedParcels?.length ?? 0) > 0;
    const aborted   = () => signal?.aborted === true;
    const startedAt = Date.now();
    const capped    = () => ACQUIRE_MAX_MS > 0 && (Date.now() - startedAt) >= ACQUIRE_MAX_MS;

    if (carrying()) {
        console.log(`${tag} ho gia un pacco a bordo - acquisizione immediata`);
        return { success: true, outcome: 'gia carico' };
    }

    let sweep = new Set();   // tile gia provate in questa "passata"
    let cycle = 0;
    while (true) {
        if (aborted()) return { success: false, error: 'acquire interrotto (abort)' };
        if (capped())  return { success: false, error: `acquire oltre ACQUIRE_MAX_MS=${ACQUIRE_MAX_MS}ms` };

        // 1) C'e un pacco visibile? Vai a prenderlo.
        const p = nearestVisibleParcel(beliefs);
        if (p) {
            const tx = Math.round(p.x), ty = Math.round(p.y);
            console.log(`${tag} pacco visibile @ (${tx},${ty}) - vado a prenderlo`);
            const arrived = await navigateInterruptible(ctx, tx, ty, signal);
            if (carrying()) { console.log(`${tag} preso in transito OK`); return { success: true, outcome: `acquisito @ (${tx},${ty})` }; }
            if (aborted())  return { success: false, error: 'acquire interrotto (abort)' };
            if (arrived) {
                const r = await ctx.socket.emitPickup();
                if (r && r.length) { console.log(`${tag} pickup OK (${r.length} pacchi)`); return { success: true, outcome: `acquisito @ (${tx},${ty})` }; }
                console.log(`${tag} pacco sparito prima del pickup - continuo`);
            } else {
                console.log(`${tag} pacco non raggiunto - continuo`);
            }
            continue;
        }

        // 2) Nessun pacco visibile -> ruota sulla prossima spawn tile e aspetta.
        const tiles = rankedSpawnTiles(beliefs);
        if (tiles.length === 0) {
            console.log(`${tag} nessuna spawn tile nota - attendo e riprovo`);
            if (await abortableSleep(acquireWaitMs(beliefs), signal) === 'aborted')
                return { success: false, error: 'acquire interrotto (abort)' };
            continue;
        }
        let next = tiles.find(t => !sweep.has(t.key));
        if (!next) { sweep = new Set(); next = tiles[0]; cycle++; }   // passata finita -> si rivisita
        sweep.add(next.key);

        console.log(`${tag} ciclo ${cycle}: vado su spawn tile (${next.x},${next.y}) [score=${next.score}]`);
        const arrived = await navigateInterruptible(ctx, next.x, next.y, signal);
        if (carrying()) { console.log(`${tag} preso in transito OK`); return { success: true, outcome: 'acquisito in transito' }; }
        if (aborted())  return { success: false, error: 'acquire interrotto (abort)' };
        if (!arrived) {
            // tile irraggiungibile ora: piccolo backoff per non ciclare a vuoto.
            console.log(`${tag} spawn tile (${next.x},${next.y}) irraggiungibile - provo la prossima`);
            if (await abortableSleep(ACQUIRE_POLL_MS, signal) === 'aborted')
                return { success: false, error: 'acquire interrotto (abort)' };
            continue;
        }

        // Sono sulla spawn tile: aspetto che compaia un pacco (poll), fino a waitMs.
        const waitMs = acquireWaitMs(beliefs);
        console.log(`${tag} su (${next.x},${next.y}), attendo uno spawn fino a ${waitMs}ms`);
        const deadline = Date.now() + waitMs;
        while (Date.now() < deadline) {
            const slept = await abortableSleep(Math.min(ACQUIRE_POLL_MS, deadline - Date.now()), signal);
            if (slept === 'aborted') return { success: false, error: 'acquire interrotto (abort)' };
            if (carrying())                  { console.log(`${tag} pickup opportunistico in attesa OK`); return { success: true, outcome: 'acquisito in attesa' }; }
            if (nearestVisibleParcel(beliefs)) { console.log(`${tag} pacco apparso - vado a prenderlo`); break; }
            if (capped()) return { success: false, error: `acquire oltre ACQUIRE_MAX_MS=${ACQUIRE_MAX_MS}ms` };
        }
        // torna in cima: o un pacco e apparso (gestito al punto 1), o ruoto tile.
    }
}


// ── FASE 2: EXECUTION DI UN SINGOLO STEP (nessuna chiamata LLM) ───────────────

/**
 * Esegue un singolo step del piano traducendolo in una (o piu) tool call.
 * Non chiama l'LLM.
 * @param {object} step - {action, target}
 * @param {object} ctx
 * @returns {Promise<{success: boolean, outcome?: string, error?: string}>}
 */
async function executeStep(step, ctx, signal = null) {
    const tools   = makeTools(ctx);
    const beliefs = ctx.beliefs;
    const action  = normalizeAction(step.action);
    const target  = step.target ?? '';

    const ok   = (outcome) => ({ success: true,  outcome: String(outcome) });
    const fail = (error)   => ({ success: false, error:   String(error) });
    const isErr = (s) => String(s).startsWith('Error');

    try {
        switch (action) {
            case 'inspect':
                return ok(await tools.inspect());

            case 'calculate': {
                const out = await tools.calculate(target);
                if (isErr(out)) return fail(out);
                const m = String(out).match(/Result:\s*(.+)/);
                if (m) ctx._lastCalcResult = m[1].trim();   // per l'eventuale answer
                return ok(out);
            }

            case 'answer': {
                const text = (ctx._lastCalcResult != null && isResultPlaceholder(target))
                    ? ctx._lastCalcResult
                    : target;
                const out = await tools.answer(text);
                return isErr(out) ? fail(out) : ok(out);
            }

            case 'set_rule': {
                const out = await tools.set_rule(target);
                return isErr(out) ? fail(out) : ok(out);
            }

            case 'navigate_to':
            case 'navigate':
            case 'move':
            case 'go':
            case 'go_to': {
                const c = parseCoords(target);
                if (!c) return fail(`target senza coordinate valide: "${target}"`);
                const out = await tools.navigate_to(`${c.x},${c.y}`);
                return isErr(out) ? fail(out) : ok(out);
            }

            case 'pickup':
                return ok(await tools.pickup());

            case 'putdown':
            case 'drop':
                return ok(await tools.putdown());

            case 'go_pick_up':
            case 'acquire_parcel':
            case 'pick_up':
            case 'pick': {
                const c = parseCoords(target);        // coordinate esplicite dal testo?
                if (!c) {
                    // Target simbolico ("nearest"/vuoto/acquire): ricerca PERSISTENTE
                    // (ruota spawn tile + aspetta gli spawn) finche non porta un pacco
                    // o finche la missione viene interrotta. Niente piu resa al primo
                    // controllo a vuoto.
                    return await acquireParcelPersistent(ctx, signal);
                }
                // Coordinate esplicite: pacco SPECIFICO -> prova-e-fallisci.
                const nav = await tools.navigate_to(`${c.x},${c.y}`);
                if (isErr(nav)) return fail(nav);
                const pick = await tools.pickup();
                if (/Nessun pacco/i.test(pick)) return fail(`${nav}; ma ${pick}`);
                return ok(`${nav}; ${pick}`);
            }

            case 'go_deliver':
            case 'deliver': {
                let c = parseCoords(target);
                if (!c) {
                    const d = nearestDelivery(beliefs);
                    if (!d) return fail('nessuna delivery tile nota');
                    c = { x: d.x, y: d.y };
                }
                const carriedBefore = beliefs.carriedParcels?.length ?? 0;
                const nav = await tools.navigate_to(`${c.x},${c.y}`);
                if (isErr(nav)) return fail(nav);
                // Durante il tragitto (e soprattutto arrivando sulla delivery tile)
                // `opportunisticActions` consegna automaticamente i pacchi. Quindi
                // se portavo qualcosa e ora non porto piu, LA CONSEGNA E AVVENUTA:
                // e un SUCCESSO, non "Niente da consegnare". (Era questo il bug del
                // "lo fa ma pensa di non averlo fatto".)
                const carriedNow = beliefs.carriedParcels?.length ?? 0;
                if (carriedBefore > 0 && carriedNow === 0) {
                    console.log(`[LLM-EXEC] consegna gia avvenuta arrivando a (${c.x},${c.y}): ${carriedBefore} pacchi`);
                    return ok(`${nav}; consegnati ${carriedBefore} pacchi (arrivando a destinazione)`);
                }
                const drop = await tools.putdown();
                if (/Niente da consegnare/i.test(drop)) {
                    // Non portavo nulla all'inizio e niente da consegnare -> vero fallimento.
                    return fail(`${nav}; ma ${drop}`);
                }
                return ok(`${nav}; ${drop}`);
            }

            default: {
                // Fallback: il modello potrebbe aver usato direttamente il nome
                // di un tool (es. "calculate", "nearest_delivery", "list_rules").
                if (typeof tools[action] === 'function') {
                    const out = await tools[action](target);
                    return isErr(out) ? fail(out) : ok(out);
                }
                return fail(`azione sconosciuta: "${step.action}"`);
            }
        }
    } catch (e) {
        return fail(e.message);
    }
}

export {
    navigateInterruptible, abortableSleep, acquireParcelPersistent, executeStep,
};
