// options.js — Generazione opzioni e deliberazione
import { beliefs, getKnownAgentPositions } from './beliefs.js';
import { smartDist, scoreParcel, nearestDeliveryDist } from './basic_functions.js';
// scoreParcel assolutamente da rivedere

/**
 * Genera le opzioni disponibili in base ai beliefs correnti.
 * Ogni opzione è un predicate: ['go_pick_up', x, y, id, score]
 *                               ['deliver', x, y, dist]
 *                               ['explore']
 *
 * NOTA: isCarrying usa doppio controllo (beliefs.carrying OR carriedParcels.length > 0)
 * perché updateSensing() può resettare beliefs.carrying a false se il server
 * è in ritardo di un frame sull'aggiornamento di carriedBy.
 * beliefs.carriedParcels invece viene settato da GoPickUp e azzerato solo
 * da Deliver → non risente del ritardo del server.
 */

// IMPORTANTE: GESTIRE OPZIONE PIÙ PACCHI

export function generateOptions() {
    const options        = [];
    const agentPositions = getKnownAgentPositions();

    // Doppio controllo: protegge dal desync server/beliefs
    const isCarrying = beliefs.carrying || beliefs.carriedParcels.length > 0;

    if (!isCarrying) {
        for (const [id, parcel] of beliefs.parcels.entries()) {
            if (parcel.carriedBy) continue;

            // Distanza dal pacco al delivery più vicino — passata a scoreParcel
            // per calcolare l'efficienza del ciclo completo me→pacco→delivery
            const delDist = nearestDeliveryDist(parcel, beliefs.deliveryPoints);
            const score   = scoreParcel(beliefs.me, parcel, agentPositions, delDist);

            options.push(['go_pick_up', parcel.x, parcel.y, id, score]);
        }
    } else {
        for (const dp of beliefs.deliveryPoints) {
            options.push(['deliver', dp.x, dp.y, smartDist(beliefs.me, dp)]);
        }
    }

    options.push(['explore']);
    return options;
}

/**
 * Sceglie la migliore opzione.
 * 1. Consegna → delivery point più vicino
 * 2. Pickup   → pacco con score più alto (se > soglia minima)
 * 3. Esplora  → fallback
 */
export function deliberate(options) {
    const SCORE_MIN  = -100;

    // Stesso doppio controllo di generateOptions
    const isCarrying = beliefs.carrying || beliefs.carriedParcels.length > 0;

    const pickupOpts  = options.filter(o => o[0] === 'go_pick_up');
    const deliverOpts = options.filter(o => o[0] === 'deliver');

    if (isCarrying && deliverOpts.length > 0)
        return deliverOpts.reduce((b, c) => c[3] < b[3] ? c : b);

    if (pickupOpts.length > 0) {
        const best = pickupOpts.reduce((b, c) => c[4] > b[4] ? c : b);
        if (best[4] >= SCORE_MIN) return best;
    }

    return ['explore'];
}