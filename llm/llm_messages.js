// llm_messages.js
// Costruzione del messaggio user STATEFUL: si aggiorna in-place ad ogni step
// (non accumula history), cosi il context resta costante.

import { snapshotWorld } from './world_state.js';

/**
 * Costruisce il messaggio user statico che traccia il progresso. Si aggiorna
 * in-place ad ogni step (non si aggiungono nuovi elementi all'array messages),
 * cosi il context resta costante.
 * @param {string} missionText
 * @param {{lastAction, lastOutcome, completedSteps, totalSteps}} state
 * @param {object} beliefs
 * @returns {string}
 */
function buildStatefulUserMessage(missionText, state, beliefs) {
    return [
        `Mission: ${missionText}`,
        '',
        '[Current World State]',
        snapshotWorld(beliefs),
        '',
        '[Last Action & Outcome]',
        `Action: ${state.lastAction ?? '(None yet)'}`,
        `Outcome: ${state.lastOutcome ?? ''}`,
        '',
        '[Progress]',
        `Steps: ${state.completedSteps} / ${state.totalSteps ?? '?'}`,
    ].join('\n');
}

export { buildStatefulUserMessage };
