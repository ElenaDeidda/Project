// =============================================================
// moves.js
// Modulo di movimento dell'agente.
//
// Offre DUE modalità di navigazione:
//
//   1. BLIND (senza memoria):
//      Muove l'agente in modo greedy verso il target,
//      senza conoscere la mappa. Utile per reazioni immediate
//      o quando la mappa non è ancora stata esplorata.
//      Funzioni: blindStep, blindMoveTo
//
//   2. SMART (con memoria):
//      Usa il BFS sulla mappa conosciuta (beliefs.mapTiles) per
//      trovare il percorso ottimale ed evitare muri.
//      Fa fallback a blindMoveTo se la zona è inesplorata.
//      Funzioni: navigateTo
//
//   3. ESPLORAZIONE:
//      Movimento casuale per scoprire nuove zone.
//      Funzioni: exploreRandomStep
//
// RIUSO:
//   - blindStep/blindMoveTo: logica di movimento da blind_pick.js
//     (blindMove) e blind_move.js, adattata per aggiornare beliefs.me
//   - navigateTo: utilizza bfsPath da basic_functions.js
//   - exploreRandomStep: logica di fallback da main.js originale
// =============================================================

import { getDirection, bfsPath } from './basic_functions.js';

// =============================================================
// MODALITÀ BLIND (senza memoria della mappa)
// =============================================================

/**
 * Esegue UN SOLO passo verso il target in modo greedy.
 * Non conosce la mappa: se c'è un muro, il server rifiuterà il movimento.
 *
 * RIUSO: logica di selezione direzione da blind_pick.js (blindMove):
 *   if (me.x < target.x) emitMove('right') ecc.
 *   Aggiunta la gestione dell'errore e l'aggiornamento di me.x/me.y.
 *
 * @param {{x:number, y:number, name:string}} me
 *        Oggetto agente. Viene modificato in-place con la nuova posizione.
 * @param {{x:number, y:number}} target  Cella obiettivo
 * @param {Object} socket                Socket Deliveroo
 * @returns {Promise<boolean>}           true se il movimento ha avuto successo
 */
export async function blindStep(me, target, socket) {
    const direction = getDirection(me, target);
    if (!direction) return true; // già nella cella target

    // IMPORTANTE: emitMove ritorna {x, y} in caso di successo,
    // oppure FALSE in caso di fallimento (muro, collisione, ecc.).
    // NON lancia eccezioni → non usare try/catch per rilevare i fallimenti.
    const result = await socket.emitMove(direction);

    if (result && result.x != null) {
        // Successo: aggiorna la posizione con le coordinate confermate dal server
        me.x = result.x;
        me.y = result.y;
        return true;
    }

    // result === false → movimento rifiutato dal server
    console.warn(`[MOVES] blindStep: movimento ${direction} rifiutato dal server`);
    return false;
}

/**
 * Naviga verso il target in modo greedy, passo dopo passo,
 * senza usare la mappa. Chiama blindStep in loop.
 *
 * Gestisce lo stallo: se l'agente non si muove per 3 passi consecutivi,
 * rinuncia (probabilmente è bloccato da un muro o un altro agente).
 *
 * RIUSO: struttura del while da blind_move.js (loop con check me.x/me.y vs target).
 *
 * @param {{x:number, y:number}} me
 * @param {{x:number, y:number}} target
 * @param {Object} socket
 * @param {number} [maxSteps=50]   Limite passi per evitare loop infiniti
 * @returns {Promise<boolean>}     true se target raggiunto
 */
export async function blindMoveTo(me, target, socket, maxSteps = 50) {
    let stuckCount = 0;

    for (let step = 0; step < maxSteps; step++) {
        // Controllo di arrivo
        if (Math.round(me.x) === Math.round(target.x) &&
            Math.round(me.y) === Math.round(target.y)) {
            return true;
        }

        const prevX = me.x;
        const prevY = me.y;

        const moved = await blindStep(me, target, socket);

        if (!moved || (me.x === prevX && me.y === prevY)) {
            stuckCount++;
            if (stuckCount >= 3) {
                console.warn(`[MOVES] blindMoveTo: agente bloccato dopo ${step + 1} passi`);
                return false;
            }
        } else {
            stuckCount = 0; // reset contatore se il movimento è riuscito
        }
    }

    console.warn(`[MOVES] blindMoveTo: raggiunto limite di ${maxSteps} passi`);
    return false;
}

// =============================================================
// MODALITÀ SMART (con memoria della mappa / BFS)
// =============================================================

/**
 * Naviga verso il target usando il percorso ottimale calcolato con BFS
 * sulla mappa conosciuta (beliefs.mapTiles).
 *
 * Flusso:
 *   1. Chiama bfsPath per trovare il percorso sulla mappa nota
 *   2. Se BFS fallisce (zona inesplorata) → fallback a blindMoveTo
 *   3. Esegue il percorso passo per passo
 *   4. Dopo ogni passo, controlla shouldStop() per l'intention revision
 *   5. Se un passo fallisce (agente in mezzo) → ricalcola il percorso
 *
 * Il parametro shouldStop() permette all'IntentionRevision di
 * interrompere la navigazione quando arriva un'intenzione più urgente.
 *
 * @param {{x:number, y:number}} me
 *        Oggetto agente. Aggiornato in-place ad ogni passo.
 * @param {{x:number, y:number}} target
 *        Cella obiettivo
 * @param {Object} socket
 *        Socket Deliveroo
 * @param {Map<string, {x:number, y:number, type:string|number}>} walkableTiles
 *        Mappa delle tile note (beliefs.mapTiles)
 * @param {Function} [shouldStop]
 *        Callback: se ritorna true, la navigazione viene interrotta.
 *        Usato dall'IntentionRevision per la deliberazione continua.
 * @param {number} [retryLimit=3]
 *        Quante volte ricalcolare il percorso in caso di blocco
 * @returns {Promise<'reached'|'stopped'|'failed'>}
 */
export async function navigateTo(
    me,
    target,
    socket,
    walkableTiles,
    shouldStop = () => false,
    retryLimit = 3
) {
    console.log(`[MOVES] navigateTo: (${Math.round(me.x)},${Math.round(me.y)}) → (${target.x},${target.y})`);

    for (let attempt = 0; attempt < retryLimit; attempt++) {

        // --- 1. Calcola percorso BFS ---
        const path = bfsPath(me, target, walkableTiles);

        if (!path) {
            // Zona inesplorata o non raggiungibile → fallback blind
            console.warn(`[MOVES] BFS senza percorso (tentativo ${attempt + 1}), uso blindMoveTo`);
            const ok = await blindMoveTo(me, target, socket);
            return ok ? 'reached' : 'failed';
        }

        if (path.length === 0) {
            return 'reached'; // già a destinazione
        }

        // --- 2. Esegui il percorso passo per passo ---
        let pathBroken = false;

        for (const nextCell of path) {
            // Controlla se l'IntentionRevision vuole fermarci
            if (shouldStop()) {
                console.log(`[MOVES] navigateTo interrotto da shouldStop()`);
                return 'stopped';
            }

            const direction = getDirection(me, nextCell);
            if (!direction) continue; // cella già raggiunta (overlap)

            // emitMove ritorna {x,y} in caso di successo, FALSE in caso di fallimento.
            // NON lancia eccezioni → nessun try/catch necessario.
            const result = await socket.emitMove(direction);

            if (result && result.x != null) {
                me.x = result.x;
                me.y = result.y;
            } else {
                // false → cella bloccata da agente o muro → ricalcola percorso
                console.warn(`[MOVES] Passo verso ${direction} rifiutato, ricalcolo percorso`);
                pathBroken = true;
                break;
            }
        }

        if (!pathBroken) {
            // Percorso completato
            const arrived = Math.round(me.x) === Math.round(target.x) &&
                            Math.round(me.y) === Math.round(target.y);
            return arrived ? 'reached' : 'failed';
        }

        // Il percorso si è spezzato: ritenta dal tentativo successivo
        // (il BFS verrà ricalcolato con la posizione aggiornata di me)
    }

    console.warn(`[MOVES] navigateTo: esauriti i tentativi di ricalcolo`);
    return 'failed';
}

// =============================================================
// ESPLORAZIONE
// =============================================================

/**
 * Muove l'agente in una direzione casuale per esplorare zone sconosciute.
 * Non garantisce il movimento (potrebbe colpire un muro).
 *
 * RIUSO: logica di fallback da main.js originale:
 *   "const randomDir = directions[Math.floor(Math.random() * directions.length)]"
 *
 * Usata in: plans.js (piano Explore)
 *
 * @param {Object} socket
 * @param {{x:number, y:number}} me  Aggiornato in-place se il movimento riesce
 * @returns {Promise<void>}
 */
export async function exploreRandomStep(socket, me) {
    const directions = ['up', 'down', 'left', 'right'];
    const randomDir  = directions[Math.floor(Math.random() * directions.length)];

    // emitMove ritorna {x,y} o false — non lancia eccezioni
    const result = await socket.emitMove(randomDir);
    if (result && result.x != null) {
        me.x = result.x;
        me.y = result.y;
    }
}
