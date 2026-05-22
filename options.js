// options.js — Generazione opzioni e deliberazione
import { beliefs, getAgentPositions, getBlockedCells } from './beliefs.js';
import { smartDist, scoreParcel, nearestDeliveryDist }  from './basic_functions.js';

const VISIBILITY_BONUS = 2;
const SPAWN_TIMEOUT    = 3000;

// ─── helpers ──────────────────────────────────────────────────────────────────

function isCarrying() {
    return beliefs.carrying || beliefs.carriedParcels.length > 0;
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
    if (isCarrying()) {
        return buildDeliverOptions();
    }

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
    if (spawns.length > 0)
        return spawns.reduce((b, c) => c[3] > b[3] ? c : b);

    return ['go_to_spawn'];
}