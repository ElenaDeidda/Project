// llm_agent.js
// Entry point + barrel dell'agente LLM: interpreta ed esegue special missions.
// Architettura decoupled (history costante, `state` mutabile traccia il progresso):
//   FASE 0 understandMission -> FASE 1 generatePlan -> FASE 2 execution loop (no LLM)
//   -> FASE 3 reflectOnError (LLM solo su errore di uno step)
// Logica nei moduli: llm_client, world_state, llm_parsers, llm_prompts,
// llm_messages, llm_tools, llm_executor, llm_planner, llm_runner.

import { initQueue, enqueue } from './mission_queue.js';
import { maybeHandleAdminSignal } from '../channel/coordination.js';
import { runMission, isProtocolMessage } from './llm_runner.js';

// ─────────────────────────────────────────────────────────────────────────────
// ENTRY POINT - collega l'agente al socket e ascolta le special missions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} socket   socket Deliveroo (DjsConnect)
 * @param {object} beliefs  i beliefs condivisi col BDI
 * @param {{navigateTo:Function, getPddlPlan?:Function}} deps  i tuoi piani
 */
export function startLlmAgent(socket, beliefs, deps) {
    // ctx condiviso tra le missioni: la queue aggiorna `lastSender`, il tool
    // `answer` lo legge per rispondere al mittente.
    const ctx = { socket, beliefs, deps, lastSender: null };

    // Bridge chiamato dalla queue per eseguire una missione.
    async function executeMission(text, senderId, signal) {
        ctx.lastSender = senderId;
        return await runMission(text, ctx, signal);
    }

    initQueue({
        beliefs,
        runMission: executeMission,
        bdiPause:   deps?.bdiPause,
        bdiResume:  deps?.bdiResume,
    });

    // Ascolto chat (sola lettura): mette in coda i messaggi plausibili come missione.
    socket.onMsg((id, name, msg) => {
        // Una missione e una stringa o {mission:'...'} / {text:'...'}; il resto si ignora.
        let text = null;
        if (typeof msg === 'string') text = msg;
        else if (msg && typeof msg.mission === 'string') text = msg.mission;
        else if (msg && typeof msg.text    === 'string') text = msg.text;
        if (!text) return;

        // Scarta i messaggi di protocollo/coordinamento di altri team.
        if (isProtocolMessage(text)) {
            console.log(`[LLM] ignoro protocollo da ${name} (${id}): "${text.slice(0, 60)}${text.length>60?'...':''}"`);
            return;
        }

        // Accetta missioni SOLO dall'admin
        if (name.toLowerCase() !== 'admin' && name.toLowerCase() !== 'lara') {
            console.log(`[LLM] ignoro messaggio da ${name} (${id}): non e admin`);
            return;
        }

        // "green"/"red" dall'admin sono segnali red-light (relay al team), non missioni.
        if (maybeHandleAdminSignal(text)) {
            console.log(`[LLM] segnale red-light da ${name}: "${text}"`);
            return;
        }

        console.log(`[LLM] Mission da ${name} (${id}): "${text}"`);
        enqueue(text, id);
    });

    console.log('[LLM] Avviato - coda missioni attiva, in ascolto chat');
}


// ─── Barrel di ri-esportazione (test/debug) ───────────────────────────────────
export { runMission, handleCoordinate, isProtocolMessage } from './llm_runner.js';
export { generatePlan, reflectOnError, understandMission, compileIntent } from './llm_planner.js';
export { executeStep, acquireParcelPersistent, navigateInterruptible, abortableSleep } from './llm_executor.js';
export { makeTools } from './llm_tools.js';
export { buildStatefulUserMessage } from './llm_messages.js';
export { parsePlan, extractFinalAnswer, normalizeAction, parseCoords, parseIntentJson } from './llm_parsers.js';
export {
    snapshotWorld, coordStr, nearestCandidate, nearestVisibleParcel,
    bestSpawnTile, rankedSpawnTiles, acquireWaitMs,
} from './world_state.js';
