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
// BDI machinery: lo stesso che usa main.js. Lo carichiamo anche qui perché
// l'LLM agent deve giocare la partita normale (raccolta + consegna) quando
// non sta eseguendo una special mission.
const { generateOptions, deliberate } = await import("./options.js");
const { IntentionRevision } = await import("./intentions.js");

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

// Loop BDI: ad ogni sensing rideliberiamo le options e pushiamo l'intenzione.
// Stesso pattern di main.js, ma con un interruttore `bdiPaused` controllato
// dall'LLM agent: quando una special mission è in esecuzione, il BDI tace
// per non rubarle l'iniziativa.
const agent = new IntentionRevision(socket);
let bdiPaused = false;

function bdiPause()  {
    if (bdiPaused) return;
    bdiPaused = true;
    agent.stop();
    console.log(`[LLM-MAIN] ⏸  BDI in pausa — mission in esecuzione`);
}
function bdiResume() {
    if (!bdiPaused) return;
    bdiPaused = false;
    console.log(`[LLM-MAIN] ▶  BDI ripreso — torno a giocare normalmente`);
}

// Log "intelligente" della predicate corrente: stampa solo quando cambia,
// così non spammiamo. Utile per vedere cosa sta facendo l'agente.
let _lastPredicate = null;
function logPredicateIfChanged(predicate) {
    const key = JSON.stringify(predicate);
    if (key === _lastPredicate) return;
    _lastPredicate = key;
    console.log(`[BDI-LLM] → ${predicate?.[0]}(${(predicate ?? []).slice(1).join(',')})`);
}

socket.onSensing((s) => {
    updateSensing(s);
    if (bdiPaused) return;
    const predicate = deliberate(generateOptions());
    logPredicateIfChanged(predicate);
    agent.push(predicate);
});

// 3. Aspetta 'you' E 'map' prima di avviare: navigate_to ha bisogno di mapTiles.
await Promise.all([
    new Promise(res => socket.once('you', res)),
    new Promise(res => socket.once('map', res)),
]);

console.log(`[LLM] Pronto. me=(${beliefs.me.x},${beliefs.me.y}) team=${beliefs.me.teamName} | mapTiles=${beliefs.mapTiles.size}`);

// 4. Avvia l'agente LLM (queue + handler missioni). Gli passiamo i due hook
//    pause/resume così la queue può silenziare il BDI durante una mission.
startLlmAgent(socket, beliefs, { navigateTo, bdiPause, bdiResume });

// Heartbeat ogni 5s: stampa stato compatto (BDI vs mission, posizione, carico)
setInterval(() => {
    const x = Math.round(beliefs.me.x);
    const y = Math.round(beliefs.me.y);
    const carried = beliefs.carriedParcels?.length ?? 0;
    const carriedValue = (beliefs.carriedParcels ?? [])
        .reduce((s, p) => s + (p.reward || 0), 0);
    const mode = bdiPaused ? '🤖 MISSION' : '🚚 BDI';
    console.log(`[HEARTBEAT] ${mode} | @(${x},${y}) score=${beliefs.me.score ?? 0} | carry=${carried} (${carriedValue}pt)`);
}, 5000);

// 5. Safety net del BDI: rideliberiamo ogni 200ms anche senza sensing nuovo
//    (uguale a main.js). Tace quando bdiPaused.
while (true) {
    if (!bdiPaused) {
        const predicate = deliberate(generateOptions());
        logPredicateIfChanged(predicate);
        agent.push(predicate);
    }
    await new Promise(r => setTimeout(r, 200));
}