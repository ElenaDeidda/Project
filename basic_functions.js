// =============================================================
// basic_functions.js
// Funzioni di utilità condivise tra tutti i moduli.
// =============================================================
 
/**
 * Calcola la distanza di Manhattan tra due punti sulla griglia.
 * Arrotonda le coordinate per gestire agenti in movimento (x = 4.6 ecc.)
 *
 * Usata in: moves.js, options.js, plans.js
 *
 * @param {{x?:number, y?:number}} a1
 * @param {{x?:number, y?:number}} a2
 * @returns {number} distanza, o Infinity se i punti non sono validi
 */
export const smartDist = (a1, a2) => {
    if (!a1 || !a2 || a1.x == null || a1.y == null || a2.x == null || a2.y == null)
        return Infinity;
    return Math.abs(Math.round(a1.x) - Math.round(a2.x)) +
           Math.abs(Math.round(a1.y) - Math.round(a2.y));
};
 
/**
 * Data la posizione corrente e un target, restituisce la direzione da seguire.
 * Priorità: prima l'asse X, poi l'asse Y.
 *
 * Usata in: moves.js (navigateTo)
 *
 * @param {{x:number, y:number}} current
 * @param {{x:number, y:number}} target
 * @returns {'up'|'down'|'left'|'right'|null} null se già a destinazione
 */

// DA RIVEDERE
export const getDirection = (current, target) => {
    if (Math.round(target.x) > Math.round(current.x)) return 'right';
    if (Math.round(target.x) < Math.round(current.x)) return 'left';
    if (Math.round(target.y) > Math.round(current.y)) return 'up';
    if (Math.round(target.y) < Math.round(current.y)) return 'down';
    return null;
};
 
/**
 * Restituisce true se l'agente è in movimento tra due celle (coordinate non intere).
 *
 * Usata in: beliefs.js (_updateAgentHistory)
 *
 * @param {{x:number, y:number}} agent
 * @returns {boolean}
 */
export const isMoving = (agent) => {
    return agent.x % 1 !== 0 || agent.y % 1 !== 0;
};
 
// =============================================================
// SCORING PACCHI
// =============================================================
 
/**
 * Calcola la distanza Manhattan dal pacco al delivery point più vicino.
 *
 * Funzione di supporto per scoreParcel: separa il calcolo della distanza
 * di consegna dallo scoring, così options.js può passarla direttamente
 * senza ricalcolarla ogni volta.
 *
 * Usata in: options.js (generateOptions) → passata a scoreParcel
 *
 * @param {{x:number, y:number}} parcel
 * @param {Array<{x:number, y:number}>} deliveryPoints  beliefs.deliveryPoints
 * @returns {number} distanza minima, o 0 se non ci sono delivery points
 */
export const nearestDeliveryDist = (parcel, deliveryPoints) => {
    if (!deliveryPoints || deliveryPoints.length === 0) return 0;
    return Math.min(...deliveryPoints.map(dp => smartDist(parcel, dp)));
};
 
/**
 * Calcola un punteggio di utilità per decidere se vale la pena raccogliere un pacco.
 *
 * Formula base:  reward / (dist_me→pacco + dist_pacco→delivery)
 *   → misura i punti guadagnati per passo.
 *   → favorisce pacchi vicini con reward alto.
 *   → penalizza detour lunghi anche se il reward è alto.
 *
 * Bonus prossimità: se il pacco è a distanza ≤ PROXIMITY_THRESHOLD
 *   → è quasi sulla nostra strada, vale la pena prenderlo anche con reward basso.
 *   → il bonus viene anch'esso diviso per totalDist per restare in scala con lo score base.
 *
 * Penalità nemico: se un agente nemico è più vicino al pacco di noi
 *   → sottrae PENALITA_NEMICO dallo score finale, rendendo il pacco quasi sempre
 *      non conveniente (evita di inseguire pacchi che perderemo).
 *
 * Usata in: options.js (generateOptions)
 *
 * @param {{x:number, y:number}} me
 * @param {{x:number, y:number, reward?:number, value?:number}} parcel
 * @param {Array<{x:number, y:number}>} knownAgents   posizioni note degli agenti nemici
 * @param {number} deliveryDist   distanza pacco→delivery più vicino (da nearestDeliveryDist)
 * @returns {number} punteggio — più alto = più desiderabile
 */
export const scoreParcel = (me, parcel, knownAgents = [], deliveryDist = 0) => {
    const PROXIMITY_THRESHOLD = 3;   // distanza sotto cui il pacco è "sulla strada"
    const PROXIMITY_BONUS     = 20;  // reward virtuale aggiunto per pacco vicinissimo
    const PENALITA_NEMICO     = 1000; // penalità se un nemico è più vicino al pacco
 
    const myDist = smartDist(me, parcel);
    if (myDist === Infinity) return -Infinity;
 
    const reward = parcel.reward ?? parcel.value ?? 0;
    if (reward <= 0) return -Infinity;
 
    // Distanza totale del ciclo: me → pacco → delivery
    const totalDist = myDist + deliveryDist;
    if (totalDist === 0) return reward; // siamo già sopra il pacco e sul delivery
 
    // Score base: efficienza (punti per passo)
    let score = reward / totalDist;
 
    // Bonus prossimità: il pacco è quasi sulla nostra strada
    if (myDist <= PROXIMITY_THRESHOLD) {
        score += PROXIMITY_BONUS / totalDist;
    }
 
    // Penalità nemico: un agente è più vicino al pacco di noi → difficile arrivarci primi
    for (const agent of knownAgents) {
        if (smartDist(agent, parcel) < myDist) {
            score -= PENALITA_NEMICO;
            break;
        }
    }
 
    return score;
};