// llm_agent.js
// Agente LLM (v2) — ascolta la chat, mette le special missions in coda e le
// fa eseguire. Il vecchio loop ReAct è stato eliminato: la pipeline ora è
//
//   chat → filtro protocolli → mission_queue → mission_parser (1 chiamata LLM
//   che "compila" il testo in JSON + guardie deterministiche) → executor:
//     - question/action/rule  → mission_executor (deterministico)
//     - coordination L3       → coordination.js (regista dei due agenti)
//
// Politica: meglio NON eseguire che eseguire male — chi non viene capito
// con certezza viene scartato a monte dal parser.
//
// USO:
//   import { startLlmAgent } from './llm_agent.js';
//   startLlmAgent(socket, beliefs, { navigateTo, bdiPause, bdiResume, activeRules });

import { initQueue, enqueue } from './mission_queue.js';
import { executeVerdict } from './mission_executor.js';
import { executeCoordination, notifyChatMessage } from './coordination.js';

// ─────────────────────────────────────────────────────────────────────────────
// FILTRO: messaggi di coordinamento di ALTRI team da scartare in ingresso.
// I team avversari shoutano in chat con loro protocolli ("ASA_COORD v1 ...",
// "[HELLOTEAM]:...") che non sono missioni del prof: si riconoscono per forma.
// (I messaggi del NOSTRO team sono oggetti {teamId,...} e non arrivano qui:
// l'estrazione del testo qui sotto li ignora già.)
// ─────────────────────────────────────────────────────────────────────────────
function isProtocolMessage(text) {
    const t = String(text).trim();
    if (!t) return true;
    if (/^\[[A-Z_0-9-]+\]/i.test(t)) return true;              // [HELLOTEAM]:...
    if (/^[A-Z][A-Z_0-9]{2,}\s+v\d+\b/.test(t)) return true;   // ASA_COORD v1
    if (/^[\{\[]/.test(t)) return true;                        // blob JSON puro
    if (/^(ASA[_-]?COORD|TEAM[_-]?MSG|MAGNAGATTI|HELLOTEAM|HELLO\s)/i.test(t)) return true;
    return false;
}

/**
 * @param {object} socket   socket Deliveroo (DjsConnect)
 * @param {object} beliefs  i beliefs condivisi col loop BDI del processo
 * @param {{navigateTo:Function, bdiPause:Function, bdiResume:Function,
 *          activeRules:object}} deps
 */
export function startLlmAgent(socket, beliefs, deps) {
    // ctx condiviso tra le missioni: la queue aggiorna lastSender prima di
    // ogni esecuzione (serve per rispondere alle domande e per il semaforo
    // verde di hold_rows).
    const ctx = { socket, beliefs, deps, lastSender: null };

    async function executeMission(text, senderId, signal, verdict) {
        ctx.lastSender = senderId;
        if (verdict?.kind === 'coordination') {
            return await executeCoordination(text, verdict, ctx, signal);
        }
        return await executeVerdict(text, verdict, ctx, signal);
    }

    initQueue({
        beliefs,
        runMission: executeMission,
        bdiPause:   deps?.bdiPause,
        bdiResume:  deps?.bdiResume,
    });

    socket.onMsg((id, name, msg) => {
        // Una missione è una stringa o {mission:'...'}/{text:'...'}; i payload
        // strutturati (incluso il nostro protocollo di squadra) si ignorano.
        let text = null;
        if (typeof msg === 'string') text = msg;
        else if (msg && typeof msg.mission === 'string') text = msg.mission;
        else if (msg && typeof msg.text    === 'string') text = msg.text;
        if (!text) return;

        // Semaforo verde di hold_rows: se stavamo aspettando un messaggio da
        // questo mittente, è il via libera e NON va in coda come missione.
        if (notifyChatMessage(id, text)) {
            console.log(`[LLM] 🟢 semaforo verde da ${name}: "${text}"`);
            return;
        }

        if (isProtocolMessage(text)) {
            console.log(`[LLM] ignoro protocollo da ${name} (${id}): "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"`);
            return;
        }

        console.log(`[LLM] Mission da ${name} (${id}): "${text}"`);
        enqueue(text, id).catch(e =>
            console.warn(`[LLM] enqueue fallita: ${e?.message ?? e}`));
    });

    console.log('[LLM] Avviato — coda missioni attiva, in ascolto chat');
}
