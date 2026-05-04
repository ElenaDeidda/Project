// moves.js — Modulo di movimento dell'agente — versione A*.
//
// La mappa completa è nota fin dall'avvio (evento 'map' di Deliveroo),
// quindi usiamo A* con euristica di Manhattan per trovare il percorso
// ottimale verso qualsiasi target già dal primo passo.
//
// NOVITÀ rispetto alla versione precedente:
//   - aStarPath accetta un parametro opzionale `blocked` (Set<string>)
//     con le chiavi "x_y" delle celle occupate da agenti avversari
//     (cella corrente + cella target). Queste celle vengono escluse
//     dal percorso esattamente come le tile non percorribili.
//   - navigateTo recupera le celle bloccate tramite getBlockedCells()
//     prima di ogni calcolo A*, così il percorso aggira sempre gli
//     agenti avversari visibili al momento della pianificazione.
//
// INTERFACCIA PUBBLICA (invariata rispetto alla versione precedente):
//   navigateTo(me, target, socket, walkableTiles, shouldStop, retryLimit)
//     → Promise<'reached' | 'stopped' | 'failed'>

import { getDirection } from './basic_functions.js';
import { getBlockedCells } from './beliefs.js';

// =============================================================
// A* PATHFINDING
// =============================================================

/**
 * Euristica di Manhattan: distanza minima garantita su griglia 4-connessa.
 * Ammissibile (non sovrastima mai) → A* è ottimale.
 */
function heuristic(a, b) {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * Coda con priorità minima (min-heap) basata su array ordinato.
 * Sufficiente per mappe Deliveroo (dimensione tipica ≤ 50×50).
 */
class MinHeap {
    #data = [];

    push(item) {
        this.#data.push(item);
        this.#data.sort((a, b) => a.f - b.f);
    }

    pop() {
        return this.#data.shift();
    }

    get size() {
        return this.#data.length;
    }
}

/**
 * Trova il percorso ottimale da start a goal con l'algoritmo A*.
 *
 * Rispetto al BFS precedente:
 *   - A* esplora prima i nodi che si avvicinano al goal → meno nodi visitati,
 *     risposta più rapida su mappe grandi o con molti ostacoli.
 *
 * @param {{x:number, y:number}} start
 * @param {{x:number, y:number}} goal
 * @param {Map<string, {type:string|number}>} walkableTiles
 *        beliefs.mapTiles — chiave "x_y", valore {type}.
 *        type '0' o 0 → non percorribile.
 * @param {Set<string>} [blocked]
 *        Celle bloccate da agenti avversari (da getBlockedCells()).
 *        Chiave "x_y". Opzionale: se omesso, non si esclude nessuna cella.
 * @returns {{x:number, y:number}[] | null}
 *        Percorso da start (escluso) a goal (incluso),
 *        array vuoto se già a destinazione,
 *        null se il goal non è raggiungibile.
 */

/*
Algoritmo:
1. Metti start in open con f = h(start, goal)
2. Finché open non è vuoto:
   a. Estrai il nodo current con f minore
   b. Se current == goal → ricostruisci e restituisci il percorso
   c. Metti current in closed (non riesaminarlo)
   d. Per ogni vicino (su/giù/sinistra/destra):
      - Salta se già in closed
      - Salta se la tile non esiste in mappa o è type '0'
      - Salta se la cella è in blocked (agente avversario)
      - Calcola tentativeG = gScore[current] + 1
      - Se tentativeG < gScore[vicino] (percorso migliore trovato):
          - Aggiorna gScore[vicino]
          - Salva cameFrom[vicino] = current
          - Aggiungi vicino a open con f = tentativeG + h(vicino, goal)
3. Se open si svuota → return null (irraggiungibile)
*/

function aStarPath(start, goal, walkableTiles, blocked) {
    const key  = (x, y) => `${Math.round(x)}_${Math.round(y)}`;
    const startKey = key(start.x, start.y);
    const goalKey  = key(goal.x, goal.y);

    if (startKey === goalKey) return [];

    //Costo reale (passi) per arrivare a ogni nodo
    const gScore = new Map();
    gScore.set(startKey, 0);

    const cameFrom = new Map();

    const open = new MinHeap();
    open.push({
        x: start.x, y: start.y,
        f: heuristic(start, goal),
        key: startKey,
    });

    const closed = new Set();

    while (open.size > 0) {
        const current = open.pop();

        if (current.key === goalKey) {
            // Ricostruisce il percorso: goal → start, poi inverte
            const path = [];
            let cur = current.key;
            while (cur !== startKey) {
                const node = cameFrom.get(cur);
                path.push({ x: node.x, y: node.y });
                cur = node.parentKey;
            }
            path.unshift({ x: goal.x, y: goal.y });
            path.reverse();
            return path;
        }

        if (closed.has(current.key)) continue;
        closed.add(current.key);

        const neighbors = [
            { x: current.x + 1, y: current.y },
            { x: current.x - 1, y: current.y },
            { x: current.x,     y: current.y + 1 },
            { x: current.x,     y: current.y - 1 },
        ];

        for (const nb of neighbors) {
            const nKey = key(nb.x, nb.y);
            if (closed.has(nKey)) continue;

            // Tile non in mappa o non percorribile → ostacolo statico
            const tile = walkableTiles.get(nKey);
            if (!tile) continue;
            if ( tile.type == 0) continue;

            // Cella occupata da un agente avversario → ostacolo dinamico
            // Non blocchiamo la cella goal: se l'agente si sposta prima che
            // ci arriviamo, il ricalcolo A* in navigateTo gestirà il caso.
            if (nKey !== goalKey && blocked?.has(nKey)) continue;
            
            const tentativeG = (gScore.get(current.key) ?? Infinity) + 1;

            if (tentativeG >= (gScore.get(nKey) ?? Infinity)) continue;

            gScore.set(nKey, tentativeG);
            cameFrom.set(nKey, { x: nb.x, y: nb.y, parentKey: current.key });

            open.push({
                x: nb.x, y: nb.y,
                f: tentativeG + heuristic(nb, { x: gx, y: gy }),
                key: nKey,
            });
        }
    }

    // Nessun percorso trovato
    return null;
}

// =============================================================
// NAVIGAZIONE PRINCIPALE
// =============================================================

/**
 * Naviga verso target usando A* sulla mappa completa (beliefs.mapTiles),
 * evitando dinamicamente le celle occupate dagli agenti avversari.
 *
 * Flusso:
 *   1. Legge le celle bloccate dagli agenti (getBlockedCells)
 *   2. Calcola il percorso A* escludendo quelle celle
 *   3. Se A* fallisce (target irraggiungibile) → restituisce 'failed'
 *   4. Esegue il percorso passo per passo
 *   5. Dopo ogni passo controlla shouldStop() per l'intention revision
 *   6. Se un passo viene rifiutato dal server (altro agente in mezzo)
 *      → ricalcola A* dalla posizione corrente (fino a retryLimit volte)
 *
 * @param {{x:number, y:number}} me         Oggetto agente (aggiornato in-place).
 * @param {{x:number, y:number}} target     Cella obiettivo.
 * @param {Object} socket                   Socket Deliveroo.
 * @param {Map<string, {type:string|number}>} walkableTiles  beliefs.mapTiles.
 * @param {Function} [shouldStop]           Callback intention revision.
 * @param {number}   [retryLimit=3]         Max ricalcoli A* per blocco temporaneo.
 * @returns {Promise<'reached' | 'stopped' | 'failed'>}
 */
export async function navigateTo(
    me,
    target,
    socket,
    walkableTiles,
    shouldStop  = () => false,
    retryLimit  = 3,
) {
    console.log(`[MOVES] navigateTo A*: (${Math.round(me.x)},${Math.round(me.y)}) → (${target.x},${target.y})`);

    for (let attempt = 0; attempt < retryLimit; attempt++) {

        // --- 1. Recupera le celle bloccate dagli agenti avversari ---
        const blocked = getBlockedCells();

        // --- 2. Calcola percorso A* ---
        const path = aStarPath(me, target, walkableTiles, blocked);

        if (path === null) {
            console.warn(`[MOVES] A*: target (${target.x},${target.y}) non raggiungibile`);
            return 'failed';
        }

        if (path.length === 0) {
            console.log(`[MOVES] A*: già a destinazione`);
            return 'reached';
        }

        console.log(`[MOVES] A* (tentativo ${attempt + 1}): percorso di ${path.length} passi`);

        // --- 3. Esegui il percorso passo per passo ---
        let pathBroken = false;

        for (const nextCell of path) {

            // Controlla se l'IntentionRevision vuole fermarci
            if (shouldStop()) {
                console.log(`[MOVES] navigateTo interrotto da shouldStop()`);
                return 'stopped';
            }

            const direction = getDirection(me, nextCell);
            if (!direction) continue; // celle coincidenti (float rounding)

            // emitMove → {x, y} se ok, false se rifiutato (muro o collisione)
            const result = await socket.emitMove(direction);

            if (result && result.x != null) {
                me.x = result.x;
                me.y = result.y;
            } else {
                console.warn(`[MOVES] Passo verso ${direction} rifiutato — ricalcolo A* (tentativo ${attempt + 1})`);
                pathBroken = true;
                break;
            }
        }

        if (!pathBroken) {
            const arrived = Math.round(me.x) === Math.round(target.x) &&
                            Math.round(me.y) === Math.round(target.y);
            return arrived ? 'reached' : 'failed';
        }

        // Percorso spezzato: al prossimo tentativo A* riparte dalla
        // posizione aggiornata di me, con le celle bloccate ricalcolate.
    }

    console.warn(`[MOVES] navigateTo: esauriti ${retryLimit} tentativi A*`);
    return 'failed';
}