// options.js — Generazione opzioni e deliberazione
import { beliefs, getAgentPositions, getBlockedCells } from './beliefs.js';
import { smartDist, scoreParcel, nearestDeliveryDist } from './basic_functions.js';

const VISIBILITY_BONUS = 2;    // peso visibilità spawn tiles nello score
const SPAWN_TIMEOUT    = 3000; // ms prima di abbandonare una spawn tile senza pacchi

/**
 * Genera le opzioni disponibili in base ai beliefs correnti.
 * Ogni opzione è un predicate: ['go_pick_up', x, y, id, score]
 *                               ['deliver', x, y, dist]
 *                               ['go_to_spawn', x, y, score]
 */
export function generateOptions() {
    const options        = [];
    const agentPositions = getAgentPositions();

    const isCarrying = beliefs.carrying || beliefs.carriedParcels.length > 0;

    if (!isCarrying) {
        for (const [id, parcel] of beliefs.parcels.entries()) {
            if (parcel.carriedBy) continue;

            const delDist = nearestDeliveryDist(parcel, beliefs.deliveryPoints);
            const score   = scoreParcel(beliefs.me, parcel, agentPositions, delDist);

            options.push(['go_pick_up', parcel.x, parcel.y, id, score]);
        }
    } else {
        for (const dp of beliefs.deliveryPoints) {
            options.push(['deliver', dp.x, dp.y, smartDist(beliefs.me, dp)]);
        }
    }

    // --- go_to_spawn ---

    // Controlla se il timeout sulla spawn tile corrente è scaduto:
    // se l'agente è sulla stessa tile da più di SPAWN_TIMEOUT ms
    // senza che sia spawnato nessun pacco, quella tile viene esclusa
    // così deliberate() sceglie la prossima migliore.
    const timedOut = beliefs.currentSpawnTile !== null &&
                     beliefs.spawnArrivalTime  !== null &&
                     Date.now() - beliefs.spawnArrivalTime > SPAWN_TIMEOUT;

    if (timedOut) {
        console.log(`[OPTIONS] Timeout spawn tile (${beliefs.currentSpawnTile.x},${beliefs.currentSpawnTile.y}) — cerco nuova posizione`);
    }

    const blocked = getBlockedCells();

    for (const [key, tile] of beliefs.mapTiles.entries()) {
        if (tile.type != '1') continue;
        if (blocked.has(key)) continue;

        const [x, y] = key.split('_').map(Number);

        // Escludi la tile corrente se il timeout è scaduto
        if (timedOut &&
            beliefs.currentSpawnTile.x === x &&
            beliefs.currentSpawnTile.y === y) continue;

        const myDist     = smartDist(beliefs.me, { x, y });
        const delDist    = nearestDeliveryDist({ x, y }, beliefs.deliveryPoints);
        const visibility = beliefs.spawnVisibility.get(key) ?? 0;
        const score      = -(myDist + delDist) + visibility * VISIBILITY_BONUS;

        options.push(['go_to_spawn', x, y, score]);
    }

    return options;
}

/**
 * Sceglie la migliore opzione.
 * 1. Consegna → delivery point più vicino
 * 2. Pickup   → pacco con score più alto (se > soglia minima)
 * 3. Spawn    → spawn tile con score più alto
 * 4. Fallback → go_to_spawn senza coordinate se tutte bloccate
 */
export function deliberate(options) {
    const SCORE_MIN = -100;

    const isCarrying = beliefs.carrying || beliefs.carriedParcels.length > 0;

    const pickupOpts  = options.filter(o => o[0] === 'go_pick_up');
    const deliverOpts = options.filter(o => o[0] === 'deliver');
    const spawnOpts   = options.filter(o => o[0] === 'go_to_spawn');

    if (isCarrying && deliverOpts.length > 0)
        return deliverOpts.reduce((b, c) => c[3] < b[3] ? c : b);

    if (pickupOpts.length > 0) {
        const best = pickupOpts.reduce((b, c) => c[4] > b[4] ? c : b);
        if (best[4] >= SCORE_MIN) return best;
    }

    if (spawnOpts.length > 0)
        return spawnOpts.reduce((b, c) => c[3] > b[3] ? c : b);

    return ['go_to_spawn'];
}
