import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";
import { beliefs, updateConfig, updateMap, updateSensing, updateCrates } from './beliefs.js';
import { generateOptions, deliberate } from './options.js';
import { IntentionRevision }           from './intentions.js';
import { initCoordination, relayInterceptDeliver } from '../channel/coordination.js';
import { formatMap }                  from './beliefs.js';
import dotenv from 'dotenv';
import fs from 'fs';

// Cerca .env.bdi specifico per il BDI, altrimenti usa .env condiviso.
const envFile = fs.existsSync('bdi/.env.bdi') ? 'bdi/.env.bdi' : '.env';
dotenv.config({ path: envFile, override: true });
console.log(`[BDI] env caricato da ${envFile}`);

// const TOKEN = process.env.TOKEN;
// if (!TOKEN) throw new Error('TOKEN mancante nel file .env');
// const HOST  = "https://deliveroojs.bears.disi.unitn.it/";
const HOST = process.env.HOST;
const TOKEN = process.env.TOKEN;

const socket = DjsConnect(HOST, TOKEN);
const agent = new IntentionRevision(socket);

// --- Listener SDK ---
socket.onConfig( (config) => updateConfig(config) );
socket.onMap( (width, height, tiles) => updateMap(width, height, tiles) );

socket.onYou( ({id, name, teamId, teamName, x, y, score}) => {
    beliefs.me.id       = id;
    beliefs.me.name     = name;
    beliefs.me.teamId   = teamId;
    beliefs.me.teamName = teamName;
    beliefs.me.x        = x;
    beliefs.me.y        = y;
    beliefs.me.score    = score;
});

const meReady  = new Promise(res => socket.once('you', res));
const mapReady = new Promise(res => socket.once('map', (w, h, t) => res({ width: w, height: h, tiles: t })));

await meReady;
const { width, height } = await mapReady;

initCoordination(socket);

// Sceglie e pusha l'intenzione corrente, dando precedenza al coordinamento:
//   - frozen   → resta fermo (red light)
//   - override → esegue la predicate forzata (rendezvous / staffetta)
//   - altrimenti deliberazione normale (con eventuale dirottamento staffetta)
function pushNext() {
    const coord = beliefs.coord;
    if (coord?.frozen)   { agent.stop(); return; }
    if (coord?.override) { agent.push(coord.override); return; }
    const predicate = relayInterceptDeliver(deliberate(generateOptions()));
    agent.push(predicate);
}


socket.onSensing( (s) => {
    updateSensing(s);
    updateCrates(s);    // riconcilia posizione casse col server
    if (beliefs.halted) return;
    pushNext();
});

console.log(formatMap(beliefs));
// --- Safety net: delibera ogni 200ms anche senza nuovi eventi sensing ---
// Utile quando un pacco sparisce per timer (non arriva nessun sensing)
while (!beliefs.halted) {
    pushNext();
    await new Promise(r => setTimeout(r, 200));
}