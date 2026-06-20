// llm_messages.js
// Costruzione del messaggio user STATEFUL: si aggiorna in-place ad ogni step
// (non accumula history), cosi il context resta costante.

import { snapshotWorld } from './world_state.js';

/**
 * Costruisce il messaggio user che traccia il progresso della missione.
 * @param {{lastAction, lastOutcome, completedSteps, totalSteps}} state
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
