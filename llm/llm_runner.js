// llm_runner.js
// Orchestrazione di una missione: Planning -> Execution -> (Reflection) ->
// Completion, con i safety net deterministici e la delega dei task cooperativi
// di livello 3 a coordination.js. Espone anche il filtro dei messaggi protocollo.

import { extractReward, extractMultiplier } from './mission_evaluator.js';
import {
    startRendezvous, startRelayAsPostman, startRedLight, startFreezeInPlace,
} from '../channel/coordination.js';
import { makeTools } from './llm_tools.js';
import { buildPrompt } from './llm_prompts.js';
import { buildStatefulUserMessage } from './llm_messages.js';
import { understandMission, compileIntent, generatePlan, reflectOnError } from './llm_planner.js';
import { executeStep } from './llm_executor.js';

// Quante volte al massimo proviamo a correggere il piano prima di arrenderci.
// Meglio fallire rapidamente che restare appesi a riflettere all'infinito.
const MAX_REFLECTIONS = 3;


// ─────────────────────────────────────────────────────────────────────────────
// COORDINAMENTO L3: configura un task cooperativo (rendezvous / staffetta /
// red-light) e ritorna subito. Il movimento vero lo fa il loop BDI via beliefs.coord.
// ─────────────────────────────────────────────────────────────────────────────
function handleCoordinate(intent) {
    // 'reactive' (freeze until message) = variante single-agent -> freeze sul posto.
    if (intent.family === 'reactive') {
        const msg = startFreezeInPlace();
        console.log(`[LLM-COORD] ${msg}`);
        return msg;
    }

    const c    = intent.coordinate || {};
    const kind = c.kind || 'unknown';
    switch (kind) {
        case 'rendezvous': {
            const at = Array.isArray(c.at) ? c.at : [];
            const x = Number(at[0]), y = Number(at[1]);
            if (!Number.isFinite(x) || !Number.isFinite(y)) {
                console.log('[LLM-COORD] rendezvous senza coordinate valide -> ignoro');
                return 'Coordinate rendezvous mancanti';
            }
            const maxDist = Number.isFinite(c.maxDist) ? c.maxDist : 3;
            const msg = startRendezvous(x, y, maxDist);
            console.log(`[LLM-COORD] ${msg}`);
            return msg;
        }
        case 'relay': {
            const msg = startRelayAsPostman();
            console.log(`[LLM-COORD] ${msg}`);
            return msg;
        }
        case 'red_light': {
            const msg = startRedLight(c.row === 'even' ? 'even' : 'odd');
            console.log(`[LLM-COORD] ${msg}`);
            return msg;
        }
        default:
            console.log(`[LLM-COORD] kind non riconosciuto: ${kind}`);
            return `Coordinate non riconosciuto: ${kind}`;
    }
}

/**
 * Esegue una missione col pattern Planning Decoupled + State-Based Context.
 * @param {string} missionText
 * @param {object} ctx        contesto con { socket, beliefs, deps, lastSender }
 * @param {AbortSignal} [signal]   se .aborted=true la missione viene interrotta
 *                                 tra uno step e l'altro
 */
async function runMission(missionText, ctx, signal = null) {
    const tools  = makeTools(ctx);
    const prompt = buildPrompt(Object.keys(tools));

    // Risultato dell'ultimo calculate, condiviso tra gli step (per "answer: result").
    ctx._lastCalcResult = null;

    // STATE TRACKER - NON viene aggiunto ai messages, traccia solo il progresso.
    const state = {
        lastAction:     null,
        lastOutcome:    null,
        completedSteps: 0,
        totalSteps:     null,
    };

    if (signal?.aborted) {
        console.log('[LLM] Interruzione prima del planning');
        return null;
    }

    // FASE 0: COMPRENSIONE (query rewriting -> intento JSON strutturato).
    // Capisce COSA fare e in che ORDINE; la decisione "saltare o no" sta SOLO
    // qui (option b), non nella coda.
    let intent = null;
    try {
        intent = await understandMission(missionText, ctx.beliefs, tools);
    } catch (e) {
        console.warn('[LLM-UNDERSTAND] errore:', e.message);
    }

    if (intent) {
        console.log(`[LLM-UNDERSTAND] family=${intent.family}${intent.reason ? ` - ${intent.reason}` : ''}`);
        if (intent.family === 'ignore') {
            // Unico caso di scarto: trappola auto-lesiva (penalita per AVERLA fatta).
            console.log('[LLM] Missione IGNORATA (trappola auto-lesiva).');
            return `Ignorata: ${intent.reason || 'trappola auto-lesiva'}`;
        }
        if (intent.family === 'coordinate' || intent.family === 'reactive') {
            // Task cooperativi di livello 3 (rendezvous / staffetta / red-light).
            // Si configurano e ritornano SUBITO: poi il loop BDI (ripreso dalla
            // coda) esegue l'override / il freeze via beliefs.coord.
            return handleCoordinate(intent);
        }
        // SAFETY NET deterministico: un'azione ATOMICA con reward NEGATIVO e una
        // trappola auto-lesiva (penalita per AVERLA fatta) -> non eseguirla, anche
        // se l'LLM l'ha classificata "atomic". Le penalita-OBBLIGO sono regole
        // (family 'rule') o reattive, gestite sopra: questo colpisce solo le
        // azioni una-tantum che fanno solo perdere punti.
        if (intent.family === 'atomic') {
            const r = extractReward(missionText);
            if (r != null && r < 0) {
                console.log(`[LLM] Missione IGNORATA (trappola: azione atomica con reward ${r}).`);
                return `Ignorata: trappola auto-lesiva (reward ${r})`;
            }
        }
        // SAFETY NET: una REGOLA con moltiplicatore < 1 e DANNOSA (seguirla
        // ridurrebbe il reward, es. "stacks of 3 to get 0.3 times the reward").
        // Non la installiamo. I moltiplicatori >= 1 (double/triple/2x) restano.
        if (intent.family === 'rule') {
            const mult = extractMultiplier(missionText);
            if (mult != null && mult < 1) {
                console.log(`[LLM] Regola IGNORATA (moltiplicatore ${mult} < 1: seguirla ridurrebbe il reward).`);
                return `Ignorata: regola dannosa (moltiplicatore ${mult}x < 1)`;
            }
        }
    }

    // FASE 1: PIANO - deterministico dall'intento; fallback al planner LLM
    // (generatePlan) se la comprensione non e utilizzabile.
    let plan;
    const compiled = intent ? compileIntent(intent, ctx.beliefs) : { steps: [] };
    if (compiled.steps.length > 0) {
        plan = { steps: compiled.steps, reasoning: intent.reason || '' };
        console.log(`[LLM] Intento compilato in ${plan.steps.length} steps (family=${intent.family})`);
    } else {
        console.log('[LLM] Comprensione non utilizzabile -> fallback al planner LLM');
        try {
            plan = await generatePlan(missionText, ctx.beliefs, tools);
        } catch (e) {
            console.error('[LLM-PLAN] Errore:', e.message);
            return null;
        }
        console.log(`[LLM] Piano generato: ${plan.steps.length} steps`);
    }
    state.totalSteps = plan.steps.length;
    if (plan.steps.length === 0) {
        console.warn('[LLM] Nessuno step eseguibile');
        return null;
    }

    // MESSAGES ARRAY - SEMPRE 2 elementi [system, user], state-based.
    const messages = [
        { role: 'system', content: prompt },
        { role: 'user',   content: buildStatefulUserMessage(missionText, state, ctx.beliefs) },
    ];

    // FASE 2: EXECUTION LOOP (nessuna chiamata LLM, solo tool call).
    // Indice esplicito invece di for...of: cosi la reflection puo rimpiazzare
    // gli step rimanenti e si puo ri-tentare dallo stesso indice.
    let reflections = 0;
    let i = 0;
    while (i < plan.steps.length) {
        if (signal?.aborted) {
            console.log('[LLM] Interruzione durante execution');
            return null;
        }

        const step = plan.steps[i];
        console.log(`[LLM-EXEC] Step ${i + 1}/${plan.steps.length}: ${step.action} -> ${step.target}`);

        let outcome;
        try {
            outcome = await executeStep(step, ctx, signal);
        } catch (e) {
            outcome = { success: false, error: e.message };
        }

        if (!outcome.success) {
            // Se e stato l'abort della coda (es. durante un acquire persistente),
            // esci pulito SENZA sprecare una reflection.
            if (signal?.aborted) {
                console.log('[LLM] Interruzione durante execution (acquire/step)');
                return null;
            }
            console.log(`[LLM-EXEC] X Errore: ${outcome.error}`);

            if (reflections >= MAX_REFLECTIONS) {
                console.error(`[LLM-REFLECTION] budget esaurito (${MAX_REFLECTIONS}) - missione fallita`);
                return null;
            }
            reflections++;

            // FASE 3: REFLECTION - correggi il piano dal passo fallito in poi.
            let revised;
            try {
                revised = await reflectOnError(
                    missionText, plan, i, outcome.error, ctx.beliefs, tools
                );
            } catch (e) {
                console.error('[LLM-REFLECTION] Errore:', e.message);
                return null;
            }
            if (revised.steps.length === 0) {
                console.error('[LLM-REFLECTION] piano rivisto vuoto - missione fallita');
                return null;
            }

            // Sostituisci gli step da i in poi col piano rivisto, tieni i completati.
            plan = { ...plan, steps: [...plan.steps.slice(0, i), ...revised.steps] };
            state.totalSteps = plan.steps.length;
            console.log(`[LLM-REFLECTION] Piano corretto: ${plan.steps.length} steps totali`);
            continue;   // ri-tenta dallo stesso indice col nuovo step
        }

        // Success: aggiorna lo state e il messaggio user in-place (no history).
        state.lastAction     = `${step.action}(${step.target})`;
        state.lastOutcome    = outcome.outcome;
        state.completedSteps = i + 1;
        messages[1].content  = buildStatefulUserMessage(missionText, state, ctx.beliefs);

        console.log(`[LLM-EXEC] OK Completato: ${outcome.outcome}`);
        i++;
    }

    console.log(`[LLM] OK Missione completata: ${state.completedSteps} steps eseguiti`);
    return `Missione completata: ${state.completedSteps}/${state.totalSteps} steps`;
}


// ─────────────────────────────────────────────────────────────────────────────
// FILTRO: messaggi di coordinamento di altri team da scartare in ingresso.
// I team avversari shoutano in chat con loro protocolli ("ASA_COORD v1 ...",
// "[HELLOTEAM]:...", "MAGNAGATTI ...") e finirebbero a saturare la queue come
// finte missioni informative. Le riconosciamo per forma e le ignoriamo.
// ─────────────────────────────────────────────────────────────────────────────
function isProtocolMessage(text) {
    const t = String(text).trim();
    if (!t) return true;
    // Tag tipo [HELLOTEAM]:..., [TEAM_X], [PROTO]
    if (/^\[[A-Z_0-9-]+\]/i.test(t)) return true;
    // PROTOCOLLO v1, NAME_LIKE v2 (token tutto-MAIUSCOLE + "v<n>")
    if (/^[A-Z][A-Z_0-9]{2,}\s+v\d+\b/.test(t)) return true;
    // Inizia con un blob JSON puro (oggetto/array) - non e linguaggio naturale
    if (/^[\{\[]/.test(t)) return true;
    // Prefissi noti di team coord
    if (/^(ASA[_-]?COORD|TEAM[_-]?MSG|MAGNAGATTI|HELLOTEAM|HELLO\s)/i.test(t)) return true;
    return false;
}

export { runMission, handleCoordinate, isProtocolMessage, MAX_REFLECTIONS };
