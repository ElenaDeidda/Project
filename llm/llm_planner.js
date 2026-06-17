// llm_planner.js
// Le fasi che usano l'LLM: FASE 0 comprensione (intento JSON), compilazione
// deterministica dell'intento in step, FASE 1 planning e FASE 3 reflection.

import { callModel } from './llm_client.js';
import { buildPlannerPrompt, buildReplannerPrompt, buildUnderstandPrompt } from './llm_prompts.js';
import { parsePlan, parseIntentJson, extractFinalAnswer } from './llm_parsers.js';
import { coordStr, nearestCandidate } from './world_state.js';

// ─────────────────────────────────────────────────────────────────────────────
// FASE 0: COMPRENSIONE (query rewriting -> intento JSON strutturato)
//
// 1 sola chiamata LLM il cui UNICO compito e capire COSA fare e in che ORDINE,
// senza inventare coordinate. Da qui ricaviamo gli step in modo DETERMINISTICO
// (compileIntent), cosi il planner non puo allucinare (es. delivery point
// inventati). Separare "capire" da "fare" e cio che rende il tutto robusto.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Chiama l'LLM una volta per CAPIRE la missione -> intento JSON strutturato.
 * @returns {Promise<object|null>} intento normalizzato, o null se non interpretabile
 */
async function understandMission(missionText, beliefs, tools) {
    const world = await tools.inspect();
    const out = await callModel([
        { role: 'system', content: buildUnderstandPrompt() },
        { role: 'user',   content: `Mission: ${missionText}\n\nCurrent world state:\n${world}` },
    ], { temperature: 0 });

    console.log(`[LLM-UNDERSTAND] risposta modello:\n${out}`);
    const intent = parseIntentJson(out);
    if (!intent || typeof intent.family !== 'string') return null;
    const fam = intent.family.toLowerCase();
    if (!['question', 'atomic', 'rule', 'reactive', 'coordinate', 'ignore'].includes(fam)) return null;
    intent.family = fam;
    return intent;
}

/**
 * Compila DETERMINISTICAMENTE l'intento in step eseguibili (stesso formato che
 * usa l'execution loop). Niente LLM, niente coordinate inventate: i target
 * vengono solo dall'intento (che a sua volta li prende solo dal testo missione).
 * @returns {{steps: Array<{action, target, description}>}}
 */
function compileIntent(intent, beliefs) {
    const steps = [];
    const push = (action, target = '') =>
        steps.push({ action, target: String(target), description: `${action}: ${target}` });

    if (intent.family === 'question') {
        if (intent.compute && String(intent.compute).trim()) {
            push('calculate', String(intent.compute).trim());
            push('answer', 'result');               // invia il valore calcolato
        } else if (intent.answer != null) {
            push('answer', String(intent.answer));
        }
        return { steps };
    }

    if (intent.family === 'atomic') {
        for (const o of Array.isArray(intent.objectives) ? intent.objectives : []) {
            const verb = String(o?.verb || '').toLowerCase();
            if (verb === 'acquire_parcel') { push('go_pick_up', 'nearest'); continue; }

            let coord = coordStr(o?.at);
            if (!coord && Array.isArray(o?.candidates) && o.candidates.length) {
                const best = nearestCandidate(o.candidates, beliefs.me);
                if (best) coord = `${best[0]},${best[1]}`;
            }
            if (verb === 'move'    && coord) push('navigate_to', coord);
            else if (verb === 'pickup')      push('go_pick_up', coord || 'nearest');
            else if (verb === 'deliver')     push('go_deliver', coord || 'nearest');
        }
        return { steps };
    }

    if (intent.family === 'rule') {
        const rules = Array.isArray(intent.rules) ? intent.rules
                    : (intent.rule ? [intent.rule] : []);
        for (const r of rules) if (r && typeof r === 'object') push('set_rule', JSON.stringify(r));
        const scope = intent.validity?.scope;
        if (scope && scope !== 'match') {
            console.warn(`[LLM-UNDERSTAND] validita '${scope}' non auto-applicata nel nucleo: la regola resta persistente (no auto-scadenza).`);
        }
        return { steps };
    }

    // ignore / reactive -> nessuno step (gestiti a monte in runMission)
    return { steps };
}


// ── FASE 1: PLANNING ─────────────────────────────────────────────────────────

/**
 * Chiama l'LLM una sola volta per generare il piano.
 * @param {string} missionText
 * @param {object} beliefs
 * @param {object} tools
 * @returns {Promise<{steps: Array<{action, target, description}>, reasoning: string}>}
 */
async function generatePlan(missionText, beliefs, tools) {
    const world = await tools.inspect();   // snapshotWorld(beliefs, activeRules)
    const out = await callModel([
        { role: 'system', content: buildPlannerPrompt() },
        { role: 'user',   content: `Mission: ${missionText}\n\nCurrent world state:\n${world}` },
    ], { temperature: 0 });

    console.log(`[LLM-PLAN] risposta modello:\n${out}`);
    const steps = parsePlan(out);
    return { steps, reasoning: extractFinalAnswer(out) ?? '' };
}


// ── FASE 3: REFLECTION (opzionale, solo su errore) ───────────────────────────

/**
 * Chiama l'LLM per correggere il piano quando uno step fallisce. Restituisce il
 * piano RIVISTO per i passi rimanenti (dal passo fallito in poi), senza
 * rigenerare quelli gia completati.
 * @param {string} missionText
 * @param {{steps: Array}} originalPlan
 * @param {number} failedStepIndex   indice 0-based del passo fallito
 * @param {string} error
 * @param {object} beliefs
 * @param {object} tools
 * @returns {Promise<{steps: Array, reasoning: string}>}
 */
async function reflectOnError(missionText, originalPlan, failedStepIndex, error, beliefs, tools) {
    const world = await tools.inspect();
    const originalPlanText = originalPlan.steps
        .map((s, idx) => `${idx + 1}. ${s.action}: ${s.target}`)
        .join('\n');

    const user = [
        `Mission: ${missionText}`,
        '',
        'Original plan:',
        originalPlanText,
        '',
        `Error at step ${failedStepIndex + 1}: ${error}`,
        '',
        'Current world state:',
        world,
        '',
        `Generate a REVISED plan from step ${failedStepIndex + 1} onwards. Do not regenerate the steps that already succeeded (1..${failedStepIndex}).`,
    ].join('\n');

    const out = await callModel([
        { role: 'system', content: buildReplannerPrompt() },
        { role: 'user',   content: user },
    ], { temperature: 0 });

    console.log(`[LLM-REFLECTION] risposta modello:\n${out}`);
    const steps = parsePlan(out, failedStepIndex);
    return { steps, reasoning: extractFinalAnswer(out) ?? '' };
}

export { understandMission, compileIntent, generatePlan, reflectOnError };
