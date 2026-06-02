import 'dotenv/config';
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";
import { startLlmAgent } from "./llm_agent.js";
import { navigateTo } from "./moves.js";
import { beliefs } from "./beliefs.js";
import { updateSensing } from "./beliefs.js";  // o come si chiama nel tuo codice

// 1. Connessione al gioco
const socket = DjsConnect(process.env.HOST + '?token=' + process.env.TOKEN);

// 2. Aggiorna i beliefs col sensing (serve all'LLM per sapere dove si trova)
socket.onYou(me => {
    beliefs.me.id       = me.id;
    beliefs.me.name     = me.name;
    beliefs.me.teamId   = me.teamId;
    beliefs.me.teamName = me.teamName;
    beliefs.me.x        = me.x;
    beliefs.me.y        = me.y;
    beliefs.me.score    = me.score;
});
socket.onSensing(s => updateSensing(s));

// 3. Aspetta il primo evento 'you' così beliefs.me ha posizione, id e teamId
//    prima che eventuali missioni inneschino tool che li leggono (navigate_to).
await new Promise(res => socket.once('you', res));

// 4. Avvia l'agente LLM (solo lettura chat per missioni; nessun handshake)
startLlmAgent(socket, beliefs, { navigateTo });