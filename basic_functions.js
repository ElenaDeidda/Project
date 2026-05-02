// =============================================================
// basic_functions.js
// Funzioni di utilità condivise tra tutti i moduli.
//
// RIUSO: smartDist è presa direttamente da basic_function.js (originale)
//        bfsPath è la novità principale: pathfinding su mappa conosciuta
// =============================================================

/**
 * Calcola la distanza di Manhattan tra due punti sulla griglia.
 * Arrotonda le coordinate per gestire agenti in movimento (x = 4.6 ecc.)
 *
 * RIUSO: logica identica a basic_function.js originale.
 * Usata in: moves.js, brain.js (scoring, deliberazione, agentHistory)
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
 * Usata in: moves.js (blindStep, navigateTo)
 *
 * @param {{x:number, y:number}} current
 * @param {{x:number, y:number}} target
 * @returns {'up'|'down'|'left'|'right'|null} null se già a destinazione
 */
export const getDirection = (current, target) => {
    if (Math.round(target.x) > Math.round(current.x)) return 'right';
    if (Math.round(target.x) < Math.round(current.x)) return 'left';
    if (Math.round(target.y) > Math.round(current.y)) return 'up';
    if (Math.round(target.y) < Math.round(current.y)) return 'down';
    return null; // già nella cella target
};

/**
 * Calcola un punteggio di utilità per decidere se vale la pena andare a prendere un pacco.
 *
 * Formula:
 *   score = reward - (distanza_mia * PESO_DISTANZA) - PENALITA_NEMICO (se un nemico è più vicino)
 *
 * Logica ispirata a main.js originale (sezione "Trova il pacco migliore considerando anche
 * gli altri agenti"), ma generalizzata come funzione riutilizzabile.
 *
 * Usata in: brain.js (generateOptions)
 *
 * @param {{x:number, y:number}} me
 * @param {{x:number, y:number, reward?:number, value?:number}} parcel
 * @param {Array<{x:number, y:number}>} knownAgents - ultime posizioni note degli agenti nemici
 * @returns {number} punteggio (più alto = più desiderabile)
 */
export const scoreParcel = (me, parcel, knownAgents = []) => {
    const PESO_DISTANZA = 2;       // quanto pesa la distanza nel punteggio
    const PENALITA_NEMICO = 500;   // penalità se un nemico è più vicino al pacco

    const myDist = smartDist(me, parcel);
    if (myDist === Infinity) return -Infinity;

    const reward = parcel.reward ?? parcel.value ?? 0;

    // Controlla se c'è almeno un agente nemico più vicino al pacco
    let enemyIsCloser = false;
    for (const agent of knownAgents) {
        if (smartDist(agent, parcel) < myDist) {
            enemyIsCloser = true;
            break;
        }
    }

    return reward - myDist * PESO_DISTANZA - (enemyIsCloser ? PENALITA_NEMICO : 0);
};
