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

// ─── L2: regole attive installate dall'LLM via set_rule() ─────────────────────
// Sono una struttura dati LOCALE al processo LLM. Il processo BDI non le vede
// (ha il suo beliefs separato). Le regole influenzano:
//   - applyRulesToBeliefs: post-processa beliefs DOPO updateSensing
//     (es. aggiunge phantom blockers su forbidden_tile; rimuove pacchi troppo
//      ricchi se max_parcel_reward)
//   - applyRulesToPredicate: modifica la predicate prima di pushare l'intention
//     (es. stack_size, zero_delivery, bonus_delivery)
const activeRules = {};

function applyRulesToBeliefs() {
    // forbidden_tile: phantom agents bloccanti. La chiave "__forbidden_X_Y" è
    // riconosciuta da snapshotWorld che li nasconde all'LLM.
    if (Array.isArray(activeRules.forbiddenTiles)) {
        for (const t of activeRules.forbiddenTiles) {
            beliefs.agents.set(`__forbidden_${t.x}_${t.y}`, {
                x: t.x, y: t.y, moving: false, direction: 'none',
                targetX: t.x, targetY: t.y,
            });
        }
    }
    // max_parcel_reward: rimuovi dai beliefs i pacchi troppo cari così
    // options.js non li considera nemmeno candidati.
    if (typeof activeRules.maxParcelReward === 'number') {
        for (const [id, p] of beliefs.parcels) {
            if ((p.reward ?? 0) > activeRules.maxParcelReward) {
                beliefs.parcels.delete(id);
            }
        }
    }
}

// Trova il pacco libero più vicino visibile. Null se non ce ne sono.
function nearestFreeParcel(beliefs) {
    const free = [...(beliefs.parcels?.values() ?? [])].filter(p => !p.carriedBy);
    if (free.length === 0) return null;
    free.sort((a, b) =>
        (Math.abs(a.x - beliefs.me.x) + Math.abs(a.y - beliefs.me.y)) -
        (Math.abs(b.x - beliefs.me.x) + Math.abs(b.y - beliefs.me.y)));
    return free[0];
}

// Sceglie una spawn tile sensata: alta visibilità, e vicina a me.
function bestSpawnTile(beliefs) {
    const spawnVis = beliefs.spawnVisibility ?? new Map();
    if (spawnVis.size === 0) return null;
    const me = beliefs.me;
    let best = null, bestScore = -Infinity;
    for (const [key, vis] of spawnVis.entries()) {
        const [x, y] = key.split('_').map(Number);
        const dist = Math.abs(x - me.x) + Math.abs(y - me.y);
        const score = vis * 10 - dist;     // visibilità prima, distanza poi
        if (score > bestScore) { best = { x, y }; bestScore = score; }
    }
    return best;
}

// Quando una regola blocca il 'deliver', l'agente DEVE comunque fare qualcosa
// di utile: cerca un pacco da raccogliere; se non ne vede, vai su una spawn
// tile (con coordinate reali, sennò GoToSpawn fa solo sleep e l'agente si
// pianta).
function redirectAwayFromDeliver(beliefs) {
    const p = nearestFreeParcel(beliefs);
    if (p) {
        return ['go_pick_up', Math.round(p.x), Math.round(p.y), p.id, p.reward];
    }
    const s = bestSpawnTile(beliefs);
    if (s) return ['go_to_spawn', s.x, s.y];
    return ['go_to_spawn'];   // fallback solo se proprio non c'è altro
}

function applyRulesToPredicate(predicate) {
    if (!predicate) return predicate;
    const [action, ...args] = predicate;

    // stack_size: il BDI vuole consegnare ma porto meno di N → reindirizzo
    // verso un pickup utile (o una spawn tile vera) per arrivare a N.
    // Se porto > N, lascio passare la consegna (meglio consegnare che impalarsi).
    if (Number.isInteger(activeRules.stackSize) && action === 'deliver') {
        const N = activeRules.stackSize;
        const carried = beliefs.carriedParcels?.length ?? 0;
        if (carried < N) {
            const alt = redirectAwayFromDeliver(beliefs);
            console.log(`[RULES] stackSize=${N}: porto ${carried} → ${alt[0]}(${alt.slice(1).join(',')})`);
            return alt;
        }
        if (carried > N) {
            console.log(`[RULES] stackSize=${N}: porto ${carried} (più del target) → consegno comunque`);
        }
    }

    // zero_delivery: la tile target è vietata → ne scelgo un'altra (la più
    // vicina che non sia nella lista).
    if (Array.isArray(activeRules.zeroDeliveries) && action === 'deliver') {
        const [x, y] = args;
        if (activeRules.zeroDeliveries.some(t => t.x === x && t.y === y)) {
            const alts = (beliefs.deliveryPoints || []).filter(
                d => !activeRules.zeroDeliveries.some(t => t.x === d.x && t.y === d.y)
            );
            if (alts.length === 0) {
                console.log(`[RULES] zeroDelivery: nessuna delivery permessa → redirect`);
                return redirectAwayFromDeliver(beliefs);
            }
            alts.sort((a, b) =>
                (Math.abs(a.x-beliefs.me.x)+Math.abs(a.y-beliefs.me.y)) -
                (Math.abs(b.x-beliefs.me.x)+Math.abs(b.y-beliefs.me.y)));
            const alt = alts[0];
            console.log(`[RULES] zeroDelivery: (${x},${y}) vietata → (${alt.x},${alt.y})`);
            return ['deliver', alt.x, alt.y];
        }
    }

    // bonus_delivery: se sto andando a una delivery NORMALE e ne esiste una
    // bonus vicina (entro 5 passi extra), preferisco quella.
    if (Array.isArray(activeRules.bonusDeliveries) && action === 'deliver') {
        const [x, y] = args;
        const targetIsBonus = activeRules.bonusDeliveries.some(t => t.x === x && t.y === y);
        if (!targetIsBonus) {
            const myDist = Math.abs(x - beliefs.me.x) + Math.abs(y - beliefs.me.y);
            for (const b of activeRules.bonusDeliveries) {
                const bDist = Math.abs(b.x - beliefs.me.x) + Math.abs(b.y - beliefs.me.y);
                if (bDist <= myDist + 5) {
                    console.log(`[RULES] bonusDelivery: ridiretto da (${x},${y}) a bonus (${b.x},${b.y})`);
                    return ['deliver', b.x, b.y];
                }
            }
        }
    }

    return predicate;
}

socket.onSensing((s) => {
    updateSensing(s);
    applyRulesToBeliefs();
    if (bdiPaused) return;
    const predicate = applyRulesToPredicate(deliberate(generateOptions()));
    logPredicateIfChanged(predicate);
    agent.push(predicate);
});

// 3. Aspetta 'you' E 'map' prima di avviare: navigate_to ha bisogno di mapTiles.
await Promise.all([
    new Promise(res => socket.once('you', res)),
    new Promise(res => socket.once('map', res)),
]);

console.log(`[LLM] Pronto. me=(${beliefs.me.x},${beliefs.me.y}) team=${beliefs.me.teamName} | mapTiles=${beliefs.mapTiles.size}`);

// 4. Avvia l'agente LLM (queue + handler missioni). Gli passiamo:
//    - navigateTo: il pathfinding A* (anche per i tool dell'LLM)
//    - bdiPause/bdiResume: per silenziare il BDI durante una mission
//    - activeRules: l'oggetto condiviso che i tool set_rule/clear_rule
//      mutano e che i filtri qui sopra leggono
startLlmAgent(socket, beliefs, { navigateTo, bdiPause, bdiResume, activeRules });

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
//    (uguale a main.js). Tace quando bdiPaused. Applichiamo sempre le regole
//    (anche ai beliefs: i phantom blockers vengono persi da updateAgents.clear,
//    quindi se sono trascorsi sensing nel frattempo li reinseriamo).
while (true) {
    if (!bdiPaused) {
        applyRulesToBeliefs();
        const predicate = applyRulesToPredicate(deliberate(generateOptions()));
        logPredicateIfChanged(predicate);
        agent.push(predicate);
    }
    await new Promise(r => setTimeout(r, 200));
}