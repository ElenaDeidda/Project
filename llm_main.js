import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";
import { startLlmAgent } from "./llm_agent.js";
import { navigateTo } from "./moves.js";
import { beliefs, updateConfig, updateMap, updateSensing } from "./beliefs.js";
import dotenv from 'dotenv';
dotenv.config({ override: true });
// 1. Connessione al gioco
const socket = DjsConnect(process.env.HOST + '?token=' + process.env.TOKEN);

// 2. Listener: config (per observation_distance ecc.), map (per pathfinding),
//    you (identità + posizione), sensing (pacchi, nemici).
socket.onConfig(c => updateConfig(c));
socket.onMap((w, h, t) => updateMap(w, h, t));
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

// 3. Aspetta 'you' E 'map' prima di avviare: navigate_to ha bisogno di mapTiles.
await Promise.all([
    new Promise(res => socket.once('you', res)),
    new Promise(res => socket.once('map', res)),
]);

console.log(`[LLM] Pronto. me=(${beliefs.me.x},${beliefs.me.y}) team=${beliefs.me.teamName} | mapTiles=${beliefs.mapTiles.size}`);

// 4. Avvia l'agente LLM (solo lettura chat per missioni; nessun handshake)
startLlmAgent(socket, beliefs, { navigateTo });