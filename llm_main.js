import dotenv from 'dotenv';
import fs from 'fs';

// Cerca .env.llm specifico per l'LLM, altrimenti usa .env condiviso.
// Va caricato PRIMA degli altri import perché llm_agent.js legge process.env
// (LITELLM_API_KEY, LOCAL_MODEL, LLM_TEMP) al momento dell'import.
const envFile = fs.existsSync('.env.llm') ? '.env.llm' : '.env';
dotenv.config({ path: envFile, override: true });
console.log(`[LLM] env caricato da ${envFile}`);

// ─── Filtro log: silenzia il "rumore" di gioco del BDI ───────────────────────
// I moduli condivisi (plans.js, options.js, intentions.js, ...) loggano con tag
// come [PLANS] [PATROL] [OPTIONS] [INTENTIONS] [BDI-LLM] [RULES] [HEARTBEAT].
// Per studiare SOLO il comportamento dell'LLM li filtriamo qui a runtime, senza
// toccare quei file (così main.js resta invariato). Sono SILENZIATI di default;
// personalizza la lista con la env LLM_LOG_MUTE:
//   LLM_LOG_MUTE=""               → rivedi tutto (nessun filtro)
//   LLM_LOG_MUTE="PLANS,PATROL"   → silenzia solo quei due tag
const MUTED_LOG_TAGS = (process.env.LLM_LOG_MUTE
        ?? 'PLANS,PATROL,OPTIONS,INTENTIONS,BDI-LLM,RULES,HEARTBEAT')
    .split(',').map(s => s.trim()).filter(Boolean);
if (MUTED_LOG_TAGS.length) {
    const muteRe = new RegExp(`^\\s*\\[(?:${MUTED_LOG_TAGS.join('|')})\\]`);
    for (const level of ['log', 'warn', 'error']) {
        const orig = console[level].bind(console);
        console[level] = (...args) => {
            if (typeof args[0] === 'string' && muteRe.test(args[0])) return;
            orig(...args);
        };
    }
    console.log(`[LLM] filtro log attivo — silenziati: ${MUTED_LOG_TAGS.join(', ')} (override con LLM_LOG_MUTE)`);
}

const { DjsConnect } = await import("@unitn-asa/deliveroo-js-sdk/client");
const { startLlmAgent } = await import("./llm_agent.js");
const { navigateTo } = await import("./moves.js");
const { beliefs, updateConfig, updateMap, updateSensing, formatMap } = await import("./beliefs.js");
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
//     (es. marca le forbidden_tile come MURI nella mappa; rimuove pacchi troppo
//      ricchi se max_parcel_reward)
//   - applyRulesToPredicate: modifica la predicate prima di pushare l'intention
//     (es. stack_size, zero_delivery, bonus_delivery)
const activeRules = {};

// Reprint coalescato della mappa quando cambiano le zone vietate (così non
// stampiamo 6 mappe per 6 tile installate in fila).
let _forbiddenReprintTimer = null;
function scheduleForbiddenMapReprint() {
    if (_forbiddenReprintTimer) clearTimeout(_forbiddenReprintTimer);
    _forbiddenReprintTimer = setTimeout(() => {
        _forbiddenReprintTimer = null;
        console.log(formatMap(beliefs));
    }, 800);
}

function applyRulesToBeliefs() {
    // forbidden_tile: MURO VERO. Marchiamo la tile come type '0' direttamente in
    // mapTiles: l'A* la salta SEMPRE — anche se fosse la destinazione (i muri non
    // hanno l'eccezione "goal" che invece avevano i vecchi phantom). È persistente
    // (mapTiles non viene azzerata da updateSensing) e reversibile (clear_rule).
    // beliefs.forbiddenTiles: "x_y" → tipo ORIGINALE (per il ripristino e per il
    // disegno con 'X' sulla mappa).
    beliefs.forbiddenTiles ??= new Map();
    const want = new Set((activeRules.forbiddenTiles ?? []).map(t => `${t.x}_${t.y}`));
    let changed = false;
    // marca come muro le tile vietate
    for (const t of activeRules.forbiddenTiles ?? []) {
        const key  = `${t.x}_${t.y}`;
        const tile = beliefs.mapTiles.get(key);
        if (!beliefs.forbiddenTiles.has(key)) {
            beliefs.forbiddenTiles.set(key, tile ? tile.type : '3');   // ricorda l'originale
            changed = true;
        }
        if (tile && tile.type !== '0') tile.type = '0';                // → muro
    }
    // ripristina quelle non più vietate (es. clear_rule)
    for (const [key, origType] of beliefs.forbiddenTiles) {
        if (!want.has(key)) {
            const tile = beliefs.mapTiles.get(key);
            if (tile) tile.type = origType;
            beliefs.forbiddenTiles.delete(key);
            changed = true;
        }
    }
    if (changed) scheduleForbiddenMapReprint();

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

// ─── Azioni "di state-modification" derivate dalle regole ─────────────────────
// Alcune regole non riguardano solo le decisioni future ma anche la situazione
// attuale (es. ho 5 pacchi in mano ma stack_size=3 → vanno scaricati 2).
// Queste vanno trasformate in azioni concrete sul mondo (emitPutdown selettivo)
// PRIMA che il BDI deliberi. Si chiama dopo updateSensing e prima di deliberate.
async function applyRulesAsActions(socket, beliefs) {
    const carried = beliefs.carriedParcels ?? [];
    if (carried.length === 0) return;

    // Se sono su una delivery tile, qualsiasi emitPutdown qui causerebbe la
    // consegna immediata di tutti i pacchi. Niente drop "tattico" su delivery.
    const x = Math.round(beliefs.me.x);
    const y = Math.round(beliefs.me.y);
    const onDelivery = (beliefs.deliveryPoints ?? []).some(d => d.x === x && d.y === y);
    if (onDelivery) return;

    const idsToDrop = new Set();

    // max_parcel_reward: scarica i pacchi con reward sopra limite
    if (typeof activeRules.maxParcelReward === 'number') {
        for (const p of carried) {
            if ((p.reward ?? 0) > activeRules.maxParcelReward) idsToDrop.add(p.id);
        }
    }

    // stack_size: se ne porto più di N, scarico gli "extra" tenendo gli N
    // di valore più alto. Compatibile con max_parcel_reward (applicato sopra).
    if (Number.isInteger(activeRules.stackSize) && carried.length > activeRules.stackSize) {
        const N = activeRules.stackSize;
        const stillKept = carried.filter(p => !idsToDrop.has(p.id));
        if (stillKept.length > N) {
            const sorted = [...stillKept].sort((a, b) => (b.reward ?? 0) - (a.reward ?? 0));
            for (const p of sorted.slice(N)) idsToDrop.add(p.id);
        }
    }

    if (idsToDrop.size > 0) {
        const ids = [...idsToDrop];
        console.log(`[RULES] scarico ${ids.length} pacchi non conformi: ${ids.join(',')} @(${x},${y})`);
        try { await socket.emitPutdown(ids); }
        catch (e) { console.warn(`[RULES] emitPutdown fallito: ${e?.message ?? e}`); }
    }
}

// Helper: la tile è davvero occupata da un nemico (non phantom-block)?
function isTileOccupiedByEnemy(tile, beliefs) {
    for (const [id, a] of beliefs.agents.entries()) {
        if (String(id).startsWith('__forbidden_')) continue;
        if (Math.round(a.x) === tile.x && Math.round(a.y) === tile.y) return true;
        if (a.moving && a.targetX === tile.x && a.targetY === tile.y) return true;
    }
    return false;
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
    // Caso "carry > N" è gestito a monte da applyRulesAsActions (scarica gli
    // extra), quindi qui ci arrivo solo se carry == N (consegno) o carry < N.
    if (Number.isInteger(activeRules.stackSize) && action === 'deliver') {
        const N = activeRules.stackSize;
        const carried = beliefs.carriedParcels?.length ?? 0;
        if (carried < N) {
            const alt = redirectAwayFromDeliver(beliefs);
            console.log(`[RULES] stackSize=${N}: porto ${carried} → ${alt[0]}(${alt.slice(1).join(',')})`);
            return alt;
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
    // bonus LIBERA (non occupata da nemici) entro 5 passi extra, preferisco
    // quella. Se sono tutte occupate, tengo la delivery normale del BDI.
    if (Array.isArray(activeRules.bonusDeliveries) && action === 'deliver') {
        const [x, y] = args;
        const targetIsBonus = activeRules.bonusDeliveries.some(t => t.x === x && t.y === y);
        if (!targetIsBonus) {
            const myDist = Math.abs(x - beliefs.me.x) + Math.abs(y - beliefs.me.y);
            for (const b of activeRules.bonusDeliveries) {
                if (isTileOccupiedByEnemy(b, beliefs)) {
                    console.log(`[RULES] bonusDelivery: (${b.x},${b.y}) occupata da nemico, skip`);
                    continue;
                }
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

socket.onSensing(async (s) => {
    updateSensing(s);
    applyRulesToBeliefs();
    await applyRulesAsActions(socket, beliefs);   // scarica pacchi non conformi
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

// Stampa UNA VOLTA la mappa con le coordinate, così è chiaro come sono i numeri.
console.log(formatMap(beliefs));

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
//    (forbidden_tile come muri, ecc.) così restano coerenti tra un sensing e l'altro.
while (true) {
    if (!bdiPaused) {
        applyRulesToBeliefs();
        await applyRulesAsActions(socket, beliefs);
        const predicate = applyRulesToPredicate(deliberate(generateOptions()));
        logPredicateIfChanged(predicate);
        agent.push(predicate);
    }
    await new Promise(r => setTimeout(r, 200));
}