import { DjsConnect }       from "@unitn-asa/deliveroo-js-sdk/client";
import { beliefs, updateConfig, updateMap, updateSensing } from './beliefs.js';
import { generateOptions, deliberate } from './options.js';
import { IntentionRevision }           from './intentions.js';
import 'dotenv/config';

const TOKEN = process.env.TOKEN;
if (!TOKEN) throw new Error('TOKEN mancante nel file .env');
const HOST  = "https://deliveroojs.bears.disi.unitn.it/";
const socket = DjsConnect(HOST, TOKEN);
const agent  = new IntentionRevision(socket);

// --- Listener SDK ---
socket.onConfig( (config) => updateConfig(config) );

socket.onMap( (width, height, tiles) => updateMap(width, height, tiles) );

socket.onYou( ({id, name, x, y, score}) => {
    beliefs.me.id = id; beliefs.me.name = name;
    beliefs.me.x  = x;  beliefs.me.y    = y;  beliefs.me.score = score;
});

// Ad ogni sensing: aggiorna i beliefs e delibera subito
socket.onSensing( (s) => {
    updateSensing(s);
    agent.push( deliberate( generateOptions() ) );
});

// --- Inizializzazione ---
// socket.me e socket.map sono undefined (enhance() non copia i class fields)
// quindi aspettiamo i primi eventi manualmente
const meReady  = new Promise(res => socket.once('you', res));
const mapReady = new Promise(res => socket.once('map', (w, h, t) => res({ width: w, height: h, tiles: t })));

await meReady;
const { width, height } = await mapReady;

console.log(`Agente: ${beliefs.me.name} @ (${beliefs.me.x},${beliefs.me.y})`);
console.log(`Mappa: ${width}x${height} | Delivery points: ${beliefs.deliveryPoints.length}`);

// --- Safety net: delibera ogni 200ms anche senza nuovi eventi sensing ---
// Utile quando un pacco sparisce per timer (non arriva nessun sensing)
while (true) {
    agent.push( deliberate( generateOptions() ) );
    await new Promise(r => setTimeout(r, 200));
}