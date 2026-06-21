// =============================================================
// basic_functions.js
// Funzioni di utilità condivise tra tutti i moduli.
// =============================================================
 
// Converte un intervallo di config ("1s", "500ms", "infinite") in millisecondi.
// 'infinite'/valori non validi → Infinity.
export function parseIntervalMs(value) {
    if (value == null || value === 'infinite') return Infinity;
    const m = String(value).match(/^(\d+(?:\.\d+)?)\s*(ms|s)?$/);
    if (!m) return Infinity;
    const val = parseFloat(m[1]);
    return (m[2] === 'ms') ? val : val * 1000;
}

// Distanza di Manhattan tra due punti. Arrotonda per gestire agenti in
// movimento (coord non intere). Infinity se i punti non sono validi.
export const smartDist = (a1, a2) => {
    if (!a1 || !a2 || a1.x == null || a1.y == null || a2.x == null || a2.y == null)
        return Infinity;
    return Math.abs(Math.round(a1.x) - Math.round(a2.x)) +
           Math.abs(Math.round(a1.y) - Math.round(a2.y));
};
 
// Direzione da seguire da current verso target (prima X, poi Y). null se già
// a destinazione.
// DA RIVEDERE
export const getDirection = (current, target) => {
    if (Math.round(target.x) > Math.round(current.x)) return 'right';
    if (Math.round(target.x) < Math.round(current.x)) return 'left';
    if (Math.round(target.y) > Math.round(current.y)) return 'up';
    if (Math.round(target.y) < Math.round(current.y)) return 'down';
    return null;
};
 
// true se l'agente è in movimento tra due celle (coordinate non intere).
export const isMoving = (agent) => {
    return agent.x % 1 !== 0 || agent.y % 1 !== 0;
};
 
// =============================================================
// SCORING PACCHI
// =============================================================
 
// Distanza Manhattan dal pacco al delivery point più vicino (0 se non ce ne
// sono). Passata a scoreParcel per non ricalcolarla.
export const nearestDeliveryDist = (parcel, deliveryPoints) => {
    if (!deliveryPoints || deliveryPoints.length === 0) return 0;
    return Math.min(...deliveryPoints.map(dp => smartDist(parcel, dp)));
};
 
// Punteggio di utilità di un pacco: reward / (dist_me→pacco + dist_pacco→delivery),
// cioè punti per passo. Bonus se molto vicino, penalità se un nemico è più
// vicino del pacco. Più alto = più desiderabile.
export const scoreParcel = (me, parcel, knownAgents = [], deliveryDist = 0, myDist = smartDist(me, parcel), decayPerStep = 0) => {    const PROXIMITY_THRESHOLD = 3;   // distanza sotto cui il pacco è "sulla strada"
    const PROXIMITY_BONUS     = 20;  // reward virtuale aggiunto per pacco vicinissimo
    const PENALITA_NEMICO     = 1000; // penalità se un nemico è più vicino al pacco
 
    if (myDist === Infinity) return -Infinity;
 
    // Valore atteso: reward × P(esiste ancora). confidence assente → 1.
    const baseReward = parcel.reward ?? parcel.value ?? 0;
    const confidence = parcel.confidence ?? 1;
    const reward = baseReward * confidence;
    if (reward <= 0) return -Infinity;
 
    // Distanza totale del ciclo: me → pacco → delivery
    const totalDist = myDist + deliveryDist;
    if (totalDist === 0) return reward; // siamo già sopra il pacco e sul delivery
 
    // Reward scontato per il decay atteso sull'intero ciclo. decayPerStep =
    // reward persi per passo; con decay 'infinite' è 0 → nessuno sconto.
    const bankedReward = reward - totalDist * decayPerStep;
    if (bankedReward <= 0) return -Infinity; // arriverebbe a valore ~0

    // Score base: efficienza (punti effettivi per passo)
    let score = bankedReward / totalDist;
 
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
    // console.log(`[scoreParcel] parcel ${parcel.id} (${parcel.x},${parcel.y}) reward=${reward} banked=${bankedReward.toFixed(1)}: score=${score.toFixed(2)} (myDist=${myDist}, delDist=${deliveryDist})`);
    return score;
};