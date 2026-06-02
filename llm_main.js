import dotenv from 'dotenv';
import fs from 'fs';

// Cerca .env.llm specifico per l'LLM, altrimenti usa .env condiviso.
// Va caricato PRIMA degli altri import perché llm_agent.js legge process.env
// (LITELLM_API_KEY, LOCAL_MODEL, LLM_TEMP) al momento dell'import.
const envFile = fs.existsSync('.env.llm') ? '.env.llm' : '.env';
dotenv.config({ path: envFile, override: true });
console.log(`[LLM] env caricato da ${envFile}`);

const { DjsConnect } = await import("@unitn-asa/deliveroo-js-sdk/client");
const { startLlmAgent } = await import("./llm_agent.js");
const { navigateTo } = await import("./moves.js");
const { beliefs, updateConfig, updateMap, updateSensing } = await import("./beliefs.js");
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