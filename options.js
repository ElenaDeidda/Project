// options.js — Generazione opzioni e deliberazione
import { beliefs, getAgentPositions, getBlockedCells } from './beliefs.js';
import { smartDist, scoreParcel, nearestDeliveryDist }  from './basic_functions.js';

const VISIBILITY_BONUS = 2;
const SPAWN_TIMEOUT    = 3000;

// ─── Adaptive multi-parcel collection ─────────────────────────────────────────
const BASE_N            = 3;      // raccoglie finché valore portato ≥ N × avg_reward
const N_MIN             = 1;      // soglia minima: consegna sempre a 1× avg_reward
const N_REDUCE_STEP     = 0.5;    // di quanto si riduce N a ogni trigger
const NO_PARCEL_TIMEOUT = 6000;   // ms senza pacchi visibili a terra → riduci N
const DECAY_THRESHOLD   = 0.75;   // se valore scende a <75% del picco → riduci N

let N_current      = BASE_N;
let sessionPeak    = 0;           // valore massimo portato in questa sessione
let lastGroundTime = null;        // ultima volta con ≥1 pacco a terra visibile
let deliverLatch   = false;       // una volta scattata soglia, rimane in modalità consegna

function resetCollection() {
    N_current      = BASE_N;
    sessionPeak    = 0;
    lastGroundTime = null;
    deliverLatch   = false;
}

function carriedValue() {
    return beliefs.carriedParcels.reduce((s, p) => s + (p.reward ?? 0), 0);
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function isCarrying() {
    return beliefs.carrying || beliefs.carriedParcels.length > 0;
}

function shouldDeliver() {
    if (!isCarrying()) { resetCollection(); return false; }
    if (deliverLatch)  return true;

    // Inizializza il timer alla prima chiamata della sessione
    if (lastGroundTime === null) lastGroundTime = Date.now();

    const avgReward = beliefs.config.GAME?.parcels?.reward_avg ?? 10;
    const capacity  = beliefs.config.GAME?.player?.capacity    ?? Infinity;
    const value     = carriedValue();

    if (value > sessionPeak) sessionPeak = value;

    // Aggiorna timer: se c'è almeno un pacco a terra in range, siamo in zona attiva
    const hasGround = [...beliefs.parcels.values()].some(p => !p.carriedBy);
    if (hasGround) lastGroundTime = Date.now();

    // 1. Capacità piena → consegna subito
    if (beliefs.carriedParcels.length >= capacity) {
        console.log(`[OPTIONS] Capacità piena (${beliefs.carriedParcels.length}/${capacity}) → consegna`);
        return (deliverLatch = true);
    }

    const now = Date.now();

    // 2. Nessun pacco visibile da troppo → zona vuota, riduci N
    if (now - lastGroundTime > NO_PARCEL_TIMEOUT && N_current > N_MIN) {
        N_current = Math.max(N_MIN, N_current - N_REDUCE_STEP);
        lastGroundTime = now;  // reset timer per dare tempo alla nuova soglia
        console.log(`[OPTIONS] Nessun pacco da ${NO_PARCEL_TIMEOUT}ms → N = ${N_current.toFixed(1)}`);
    }

    // 3. Valore decaduto troppo rispetto al picco → riduci N
    if (sessionPeak > 0 && value < sessionPeak * DECAY_THRESHOLD && N_current > N_MIN) {
        N_current = Math.max(N_MIN, N_current - N_REDUCE_STEP);
        sessionPeak = value;  // aggiorna picco per evitare trigger ripetuti
        console.log(`[OPTIONS] Decay valore (${value.toFixed(0)}/${sessionPeak.toFixed(0)}) → N = ${N_current.toFixed(1)}`);
    }

    // 4. Soglia raggiunta: valore portato ≥ N × avg_reward
    if (value >= N_current * avgReward) {
        console.log(`[OPTIONS] Soglia: ${value.toFixed(0)} ≥ ${(N_current * avgReward).toFixed(0)} → consegna`);
        return (deliverLatch = true);
    }

    return false;
}

/**
 * Restituisce true se l'agente è fermo sulla spawn tile corrente
 * da più di SPAWN_TIMEOUT ms senza che sia spawnato nulla.
 */
function isSpawnTiledOut() {
    return beliefs.currentSpawnTile !== null
        && beliefs.spawnArrivalTime  !== null
        && Date.now() - beliefs.spawnArrivalTime > SPAWN_TIMEOUT;
}

/**
 * Restituisce true se la tile (x,y) è la spawn tile andata in timeout.
 */
function isTimedOutTile(x, y) {
    return isSpawnTiledOut()
        && beliefs.currentSpawnTile.x === x
        && beliefs.currentSpawnTile.y === y;
}

// ─── sezioni di generateOptions ───────────────────────────────────────────────

function buildPickupOptions(agentPositions) {
    const options = [];
    const blocked = getBlockedCells();

    for (const [id, parcel] of beliefs.parcels.entries()) {
        // Già portato da qualcuno
        if (parcel.carriedBy) continue;

        // Tile occupata da un agente avversario: non riusciremmo a raccoglierlo
        const key = `${Math.round(parcel.x)}_${Math.round(parcel.y)}`;
        if (blocked.has(key)) continue;

        const delDist = nearestDeliveryDist(parcel, beliefs.deliveryPoints);
        const score   = scoreParcel(beliefs.me, parcel, agentPositions, delDist);

        // Scarta subito pacchi con score negativo infinito (irraggiungibili o reward 0)
        if (score === -Infinity) continue;

        options.push(['go_pick_up', parcel.x, parcel.y, id, score]);
    }

    return options;
}

function buildDeliverOptions() {
    // Nessun pacco da consegnare → nessuna opzione
    if (beliefs.deliveryPoints.length === 0) return [];

    return beliefs.deliveryPoints.map(dp => [
        'deliver',
        dp.x,
        dp.y,
        smartDist(beliefs.me, dp),
    ]);
}

function buildSpawnOptions() {
    const blocked = getBlockedCells();
    const options = [];

    if (isSpawnTiledOut()) {
        console.log(`[OPTIONS] Timeout spawn tile ` +
            `(${beliefs.currentSpawnTile.x},${beliefs.currentSpawnTile.y}) — cerco nuova`);
    }

    for (const [key, tile] of beliefs.mapTiles.entries()) {
        if (tile.type !== '1') continue;

        // Tile occupata da un agente avversario
        if (blocked.has(key)) continue;

        const [x, y] = key.split('_').map(Number);

        // Esclude la tile andata in timeout
        if (isTimedOutTile(x, y)) continue;

        const myDist     = smartDist(beliefs.me, { x, y });
        const delDist    = nearestDeliveryDist({ x, y }, beliefs.deliveryPoints);
        const visibility = beliefs.spawnVisibility.get(key) ?? 0;

        // Score: premia tile vicine, vicine a un delivery e con alta visibilità spawn
        const score = -(myDist + delDist) + visibility * VISIBILITY_BONUS;

        options.push(['go_to_spawn', x, y, score]);
    }

    return options;
}

// ─── API pubblica ──────────────────────────────────────────────────────────────

/**
 * Genera le opzioni disponibili in base ai beliefs correnti.
 *
 * Casi mutualmente esclusivi:
 *   - Se stai portando pacchi  → solo opzioni 'deliver'
 *   - Altrimenti               → opzioni 'go_pick_up' + 'go_to_spawn'
 */
export function generateOptions() {
    if (shouldDeliver()) {
        return buildDeliverOptions();
    }

    // Non sta portando nulla, OPPURE sta portando ma non ha ancora raggiunto
    // la soglia → continua a cercare pacchi da raccogliere
    const agentPositions = getAgentPositions();
    return [
        ...buildPickupOptions(agentPositions),
        ...buildSpawnOptions(),
    ];
}

/**
 * Sceglie la migliore opzione dall'insieme generato da generateOptions().
 *
 * Priorità:
 *   1. deliver  → delivery point con distanza Manhattan minima
 *   2. go_pick_up → pacco con score massimo (se ≥ SCORE_MIN)
 *   3. go_to_spawn → spawn tile con score massimo
 *   4. fallback → ['go_to_spawn'] senza coordinate
 */
export function deliberate(options) {
    const SCORE_MIN = -100;

    if (isCarrying()) {
        const delivers = options.filter(o => o[0] === 'deliver');
        if (delivers.length > 0)
            return delivers.reduce((best, cur) => cur[3] < best[3] ? cur : best);
    }

    const pickups = options.filter(o => o[0] === 'go_pick_up');
    if (pickups.length > 0) {
        const best = pickups.reduce((b, c) => c[4] > b[4] ? c : b);
        if (best[4] >= SCORE_MIN) return best;
    }

    const spawns = options.filter(o => o[0] === 'go_to_spawn');
    if (spawns.length > 0) {
        spawns.sort((a, b) => b[3] - a[3]);
        const top2 = spawns.slice(0, 2).map(o => `(${o[1]},${o[2]})=${o[3].toFixed(1)}`).join(' | ');
        console.log(`[DELIBERATE] spawn top2: ${top2}`);
        return spawns[0];
    }

    return ['go_to_spawn'];
}