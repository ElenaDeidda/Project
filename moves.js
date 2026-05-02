// =============================================================
// moves.js
// Modulo di movimento dell'agente — versione A*.
//
// La mappa completa è nota fin dall'avvio (evento 'map' di Deliveroo),
// quindi l'esplorazione cieca non ha più senso: usiamo A* con
// euristica di Manhattan per trovare il percorso ottimale verso
// qualsiasi target già dal primo passo.
//
// DIFFERENZE rispetto alla versione precedente:
//   - bfsPath → aStarPath (più efficiente su griglie grandi: esplora
//     meno nodi grazie all'euristica che guida la ricerca verso il goal)
//   - Rimossi: blindStep, blindMoveTo (mappa sempre nota → mai usati)
//   - Rimosso: exploreRandomStep (l'agente non ha zone inesplorate)
//     ⚠️  Il piano Explore in plans.js va rimosso o sostituito con
//         un piano di "attesa intelligente" (es. muoversi verso la
//         zona di spawn più vicina in attesa di nuovi pacchi).
//
// INTERFACCIA PUBBLICA (identica alla versione precedente → plans.js
// non richiede modifiche):
//   navigateTo(me, target, socket, walkableTiles, shouldStop, retryLimit)
//     → Promise<'reached' | 'stopped' | 'failed'>
// =============================================================

import { getDirection } from './basic_functions.js';

// =============================================================
// A* PATHFINDING
// =============================================================

/**
 * Euristica di Manhattan: distanza minima garantita su griglia 4-connessa.
 * Ammissibile (non sovrastima mai) → A* è ottimale.
 *
 * @param {{x:number, y:number}} a
 * @param {{x:number, y:number}} b
 * @returns {number}
 */
function heuristic(a, b) {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * Coda con priorità minima (min-heap) basata su array ordinato.
 * Sufficiente per mappe Deliveroo (dimensione tipica ≤ 50×50).
 * Per mappe molto grandi si potrebbe sostituire con un heap binario.
 */
class MinHeap {
    #data = [];

    push(item) {
        this.#data.push(item);
        // Inserimento ordinato per f (costo stimato totale)
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
 *   - BFS esplora i nodi in ordine di numero di passi (anelli concentrici)
 *   - A* esplora prima i nodi che si avvicinano al goal → meno nodi visitati,
 *     risposta più rapida specialmente su mappe grandi o con molti ostacoli
 *
 * @param {{x:number, y:number}} start
 * @param {{x:number, y:number}} goal
 * @param {Map<string, {type:string|number}>} walkableTiles
 *        beliefs.mapTiles — chiave "x_y", valore {type}.
 *        type '0' o 0 → non percorribile.
 * @returns {{x:number, y:number}[] | null}
 *        Percorso da start (escluso) a goal (incluso),
 *        array vuoto se già a destinazione,
 *        null se il goal non è raggiungibile.
 */

/*
1. Metti start in open con f = h(start, goal)
2. Finché open non è vuoto:
   a. Estrai il nodo current con f minore
   b. Se current == goal → ricostruisci e restituisci il percorso
   c. Metti current in closed (non riesaminarlo)
   d. Per ogni vicino (su/giù/sinistra/destra):
      - Salta se già in closed
      - Salta se la tile non esiste in mappa o è type '0'
      - Calcola tentativeG = gScore[current] + 1
      - Se tentativeG < gScore[vicino] (percorso migliore trovato):
          - Aggiorna gScore[vicino]
          - Salva cameFrom[vicino] = current
          - Aggiungi vicino a open con f = tentativeG + h(vicino, goal)
3. Se open si svuota → return null (irraggiungibile) */

function aStarPath(start, goal, walkableTiles) {
    const key  = (x, y) => `${Math.round(x)}_${Math.round(y)}`;
    const sx   = Math.round(start.x);
    const sy   = Math.round(start.y);
    const gx   = Math.round(goal.x);
    const gy   = Math.round(goal.y);

    const startKey = key(sx, sy);
    const goalKey  = key(gx, gy);

    if (startKey === goalKey) return [];

    // g(n) = costo reale dal nodo start al nodo n (numero di passi)
    const gScore = new Map();
    gScore.set(startKey, 0);

    // Per ricostruire il percorso a ritroso
    const cameFrom = new Map();

    const open = new MinHeap();
    open.push({
        x: sx,
        y: sy,
        f: heuristic({ x: sx, y: sy }, { x: gx, y: gy }),
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
            // path ora è [nodo prima del goal, ..., nodo dopo start]
            // aggiungiamo il goal in testa e invertiamo
            path.unshift({ x: gx, y: gy });
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

            const tile = walkableTiles.get(nKey);
            if (!tile) continue;                    // tile non in mappa → ostacolo
            if (tile.type === '0' || tile.type === 0) continue; // non percorribile

            const tentativeG = (gScore.get(current.key) ?? Infinity) + 1;

            if (tentativeG >= (gScore.get(nKey) ?? Infinity)) continue;

            // Percorso migliore trovato per nb
            gScore.set(nKey, tentativeG);
            cameFrom.set(nKey, { x: nb.x, y: nb.y, parentKey: current.key });

            open.push({
                x: nb.x,
                y: nb.y,
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
 * Naviga verso target usando A* sulla mappa completa (beliefs.mapTiles).
 *
 * Flusso:
 *   1. Calcola il percorso A* sulla mappa nota
 *   2. Se A* fallisce (target irraggiungibile) → restituisce 'failed'
 *      (non c'è fallback blind perché la mappa è sempre nota per intero)
 *   3. Esegue il percorso passo per passo
 *   4. Dopo ogni passo controlla shouldStop() per l'intention revision
 *   5. Se un passo viene rifiutato dal server (altro agente in mezzo)
 *      → ricalcola A* dalla posizione corrente (fino a retryLimit volte)
 *
 * @param {{x:number, y:number}} me
 *        Oggetto agente. Aggiornato in-place ad ogni passo.
 * @param {{x:number, y:number}} target
 *        Cella obiettivo.
 * @param {Object} socket
 *        Socket Deliveroo.
 * @param {Map<string, {type:string|number}>} walkableTiles
 *        beliefs.mapTiles.
 * @param {Function} [shouldStop]
 *        Callback: se ritorna true, interrompe la navigazione.
 *        Usato dall'IntentionRevision per la deliberazione continua.
 * @param {number} [retryLimit=3]
 *        Quante volte ricalcolare A* in caso di blocco temporaneo
 *        (es. un agente nemico occupa momentaneamente il percorso).
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

        // --- 1. Calcola percorso A* ---
        const path = aStarPath(me, target, walkableTiles);

        if (path === null) {
            console.warn(`[MOVES] A*: target (${target.x},${target.y}) non raggiungibile`);
            return 'failed';
        }

        if (path.length === 0) {
            console.log(`[MOVES] A*: già a destinazione`);
            return 'reached';
        }

        console.log(`[MOVES] A* (tentativo ${attempt + 1}): percorso di ${path.length} passi`);

        // --- 2. Esegui il percorso passo per passo ---
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
            // NON lancia eccezioni → nessun try/catch
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
        // posizione aggiornata di me, trovando un percorso alternativo
        // che aggira l'agente bloccante
    }

    console.warn(`[MOVES] navigateTo: esauriti ${retryLimit} tentativi A*`);
    return 'failed';
}