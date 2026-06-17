// llm_agent.js
// Agente LLM (parte 2 del progetto) - interpreta special missions in linguaggio
// naturale e le esegue chiamando i tool del tuo sistema.
//
// Architettura DECOUPLED (slide 12 del prof): Memory -> Planner -> Exec(Tools) -> Replan?
// Pattern di esecuzione: Planning Decoupled + State-Based Context.
//   FASE 0  understandMission() -> 1 chiamata LLM: intento JSON strutturato
//   FASE 1  generatePlan()      -> 1 chiamata LLM (o compileIntent deterministico)
//   FASE 2  execution loop       -> esegue gli step con SOLO tool call (0 LLM)
//   FASE 3  reflectOnError()     -> chiamata LLM opzionale, SOLO su errore di uno step
// Niente accumulo di history: l'array `messages` resta [system, user] (2 elementi)
// e uno `state` mutabile traccia il progresso -> context costante (~400-600 token).
//
// Questo file e ora un ENTRY POINT SOTTILE + BARREL: la logica vive nei moduli
// dedicati (vedi import sotto), cosi l'architettura decoupled e esplicita anche
// nel filesystem. La superficie pubblica (startLlmAgent + export interni per
// test/debug) resta INVARIATA.
//
//   llm_client.js    config LLM + callModel
//   world_state.js   snapshotWorld + helper deterministici sui beliefs
//   llm_parsers.js   parsing di piano / azioni / coordinate / intento JSON
//   llm_prompts.js   builder dei prompt (ReAct / planner / replanner / understand)
//   llm_messages.js  messaggio user stateful
//   llm_tools.js     tool registry (makeTools)
//   llm_executor.js  primitive di esecuzione (FASE 2) + acquire persistente
//   llm_planner.js   FASE 0 / FASE 1 / FASE 3 (chiamate LLM)
//   llm_runner.js    orchestrazione runMission + coordinamento L3 + filtro chat
//
// USO:
//   import { startLlmAgent } from './llm_agent.js';
//   startLlmAgent(socket, beliefs, { navigateTo, getPddlPlan });

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
    // ctx e condiviso tra le missioni: la queue ne aggiorna `lastSender` prima
    // di ogni esecuzione, e il tool `answer` lo legge per rispondere al mittente.
    const ctx = { socket, beliefs, deps, lastSender: null };

    // Bridge: la queue esegue le missioni chiamando questa funzione.
    // Riceve text, senderId e un AbortSignal.
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

    // Ascolto chat: SOLO lettura, nessun handshake.
    // Ogni messaggio plausibile come missione viene messo in coda con priorita.
    socket.onMsg((id, name, msg) => {
        // Una missione e una stringa o un oggetto {mission:'...'} / {text:'...'}.
        // Tutto il resto (payload strutturati interni) viene ignorato.
        let text = null;
        if (typeof msg === 'string') text = msg;
        else if (msg && typeof msg.mission === 'string') text = msg.mission;
        else if (msg && typeof msg.text    === 'string') text = msg.text;
        if (!text) return;

        // Filtro: scarta i messaggi di coordinamento di altri team (i loro
        // agenti shoutano protocolli tipo "ASA_COORD v1 ...", "[HELLOTEAM]:..."
        // - non sono missioni del prof e ci farebbero solo perdere tempo.
        if (isProtocolMessage(text)) {
            console.log(`[LLM] ignoro protocollo da ${name} (${id}): "${text.slice(0, 60)}${text.length>60?'...':''}"`);
            return;
        }

        // Accetta missioni SOLO dall'admin
        if (name.toLowerCase() !== 'admin' && name.toLowerCase() !== 'lara') {
            console.log(`[LLM] ignoro messaggio da ${name} (${id}): non e admin`);
            return;
        }

        // Se e in corso un red-light, "green"/"red" dall'admin sono SEGNALI di
        // via-libera/stop (relay al team), non nuove missioni.
        if (maybeHandleAdminSignal(text)) {
            console.log(`[LLM] segnale red-light da ${name}: "${text}"`);
            return;
        }

        console.log(`[LLM] Mission da ${name} (${id}): "${text}"`);
        enqueue(text, id);
    });

    console.log('[LLM] Avviato - coda missioni attiva, in ascolto chat');
}


// ─────────────────────────────────────────────────────────────────────────────
// Barrel di RI-ESPORTAZIONE - utili per test e debug. La superficie pubblica
// resta identica a prima del decoupling (startLlmAgent + questi simboli):
// llm_main.js continua a importare solo startLlmAgent da qui.
// ─────────────────────────────────────────────────────────────────────────────
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
