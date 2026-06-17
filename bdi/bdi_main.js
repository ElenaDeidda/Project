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
/*molto importante: aggiorna la config prima di qualsiasi altro evento, così beliefs è sempre consistente con la config (es. observation_distance)*/
/*Il sotto-oggetto config.GAME è il più utile

config.GAME.player.movement_duration    // ms per muoversi di un tile
config.GAME.player.observation_distance // quanti tile riesci a "vedere"
config.GAME.player.capacity             // quanti pacchi puoi portare

config.GAME.parcels.generation_event    // frequenza spawning pacchi
config.GAME.parcels.decaying_event      // frequenza decay reward
config.GAME.parcels.max                 // max pacchi sulla mappa
config.GAME.parcels.reward_avg          // reward medio
config.GAME.parcels.reward_variance

config.GAME.npcs[i].moving_event        // frequenza movimento NPC
config.GAME.npcs[i].type               // 'random' | 'intelligent'
config.GAME.npcs[i].count
 */

socket.onMap( (width, height, tiles) => updateMap(width, height, tiles) );
/*Il server manda l'evento una volta sola all'avvio, con:

Parametro	Tipo	Contenuto
width	number	larghezza mappa in tile
height	number	altezza mappa in tile
tiles	IOTile[]	array di tile con x, y, type
I valori di type che contano sono:

1 → tile normale (percorribile)
2 / 'delivery' → punto di consegna 
updateMap costruisce due strutture:

// 1. mappa navigabile: chiave "x_y" → {x, y, type}
beliefs.mapTiles.set(`${tile.x}_${tile.y}`, { x, y, type });

// 2. lista delivery points, usata per scegliere dove consegnare
if (tile.type === 2 || tile.type === 'delivery')
    beliefs.deliveryPoints.push({ x, y });
beliefs.mapTiles viene poi usata in navigateTo (in moves.js) per sapere quali celle sono percorribili durante il pathfinding.
beliefs.deliveryPoints viene usata da options.js per scegliere il delivery point più vicino.
*/

socket.onYou( ({id, name, teamId, teamName, x, y, score}) => {
    beliefs.me.id       = id;
    beliefs.me.name     = name;
    beliefs.me.teamId   = teamId;
    beliefs.me.teamName = teamName;
    beliefs.me.x        = x;
    beliefs.me.y        = y;
    beliefs.me.score    = score;
});

/*sensing = {
    positions: [{x, y}, ...]       // tile percorribili visibili (non usato da noi)
    agents:    [IOAgent, ...]       // agenti nel raggio di osservazione
    parcels:   [IOParcel, ...]      // pacchi nel raggio di osservazione
    crates:    [IOCrate, ...]       // casse (non rilevanti per Deliveroo base)
}
 sensing.agents — gli altri agenti visibili

{
    id:       string    // identificatore univoco
    name:     string
    teamId:   string
    teamName: string
    x?:       number    // undefined se in movimento tra due tile
    y?:       number    // undefined se in movimento tra due tile
    score:    number
    penalty:  number
}
    
sensing.parcels — i pacchi visibili

{
    id:         string
    x:          number
    y:          number
    reward:     number    // decade nel tempo
    carriedBy?: string    // undefined se a terra, id agente se portato
}

sensing
  ├── .parcels  → updateSensing → beliefs.parcels / carrying / carriedParcels
  ├── .agents   → _updateAgentHistory → beliefs.agentHistory
  └── .positions, .crates  → ignorati

*/

// --- Inizializzazione ---
// socket.me e socket.map sono undefined (enhance() non copia i class fields)
// quindi aspettiamo i primi eventi manualmente
const meReady  = new Promise(res => socket.once('you', res));
const mapReady = new Promise(res => socket.once('map', (w, h, t) => res({ width: w, height: h, tiles: t })));

await meReady;
const { width, height } = await mapReady;

// console.log(`Connesso Agente ${beliefs.me.name} con id = ${beliefs.me.id}, @ (${beliefs.me.x},${beliefs.me.y})`);
// console.log(`Mappa: ${width}x${height} | Delivery points: ${beliefs.deliveryPoints.length}`);

// Coordinamento di team (livello 3): accende communication.js e i beliefs.coord.
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

// Registra sensing DOPO che beliefs.me.id è garantito impostato da onYou
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