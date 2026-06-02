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
    beliefs.me.x = me.x;
    beliefs.me.y = me.y;
    beliefs.me.id = me.id;
    beliefs.me.score = me.score;
});
socket.onSensing(s => updateSensing(s));
// 3. Avvia l'agente LLM
startLlmAgent(socket, beliefs, { navigateTo });