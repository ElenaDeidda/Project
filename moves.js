import { getDirection } from './basic_functions.js';
import { getBlockedCells, beliefs } from './beliefs.js';

function heuristic(a, b) {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

class MinHeap {
    #data = [];
    push(item) {
        this.#data.push(item);
        this.#data.sort((a, b) => a.f - b.f);
    }
    pop()        { return this.#data.shift(); }
    get size()   { return this.#data.length; }
}

const ARROW_TYPES = new Set(['→', '←', '↑', '↓']);
const ARROW_BLOCKED = {
    '→': (cur, nb) => nb.x < cur.x,
    '←': (cur, nb) => nb.x > cur.x,
    '↑': (cur, nb) => nb.y < cur.y,
    '↓': (cur, nb) => nb.y > cur.y,
};

function aStarPath(start, goal, walkableTiles, blocked, isDirectional = false) {
    const key      = (x, y) => `${Math.round(x)}_${Math.round(y)}`;
    const startKey = key(start.x, start.y);
    const goalKey  = key(goal.x, goal.y);

    if (startKey === goalKey) return [];

    const gScore   = new Map();
    gScore.set(startKey, 0);

    const cameFrom = new Map();

    const open = new MinHeap();
    open.push({ x: start.x, y: start.y, f: heuristic(start, goal), key: startKey });

    const closed = new Set();

    while (open.size > 0) {
        const current = open.pop();

        if (current.key === goalKey) {
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

        const currentTile = walkableTiles.get(current.key);

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
            if (!tile) continue;
            if (tile.type === 0 || tile.type === '0') continue;

            // Vincolo direzionale: attivo solo su mappe direzionali
            // e solo se la tile corrente è una freccia
            if (isDirectional && ARROW_TYPES.has(currentTile?.type)) {
                if (ARROW_BLOCKED[currentTile.type](current, nb)) continue;
            }

            if (nKey !== goalKey && blocked?.has(nKey)) continue;

            const tentativeG = (gScore.get(current.key) ?? Infinity) + 1;
            if (tentativeG >= (gScore.get(nKey) ?? Infinity)) continue;

            gScore.set(nKey, tentativeG);
            cameFrom.set(nKey, { x: nb.x, y: nb.y, parentKey: current.key });

            open.push({
                x: nb.x, y: nb.y,
                f: tentativeG + heuristic(nb, goal),
                key: nKey,
            });
        }
    }

    return null;
}

// BFS single-source: distanza reale di percorso dalla posizione `start` verso
// TUTTE le celle raggiungibili, rispettando muri, vincoli direzionali e celle
// bloccate dagli agenti. Una sola passata O(celle).
// Ritorna una Map "x_y" → distanza; le celle assenti sono irraggiungibili (∞).
export function reachableDistances(start, walkableTiles, blocked, isDirectional = false) {
    const key  = (x, y) => `${Math.round(x)}_${Math.round(y)}`;
    const dist = new Map();

    const sx = Math.round(start.x), sy = Math.round(start.y);
    const startKey = key(sx, sy);
    dist.set(startKey, 0);

    const queue = [{ x: sx, y: sy, key: startKey }];
    let head = 0;

    while (head < queue.length) {
        const current     = queue[head++];
        const currentTile = walkableTiles.get(current.key);
        const d           = dist.get(current.key);

        const neighbors = [
            { x: current.x + 1, y: current.y },
            { x: current.x - 1, y: current.y },
            { x: current.x,     y: current.y + 1 },
            { x: current.x,     y: current.y - 1 },
        ];

        for (const nb of neighbors) {
            const nKey = key(nb.x, nb.y);
            if (dist.has(nKey)) continue;

            const tile = walkableTiles.get(nKey);
            if (!tile) continue;
            if (tile.type === 0 || tile.type === '0') continue;

            // Vincolo direzionale: se la tile corrente è una freccia, blocca
            // i movimenti vietati (stessa logica dell'A*)
            if (isDirectional && ARROW_TYPES.has(currentTile?.type)) {
                if (ARROW_BLOCKED[currentTile.type](current, nb)) continue;
            }

            // Non si attraversa né si entra in una cella occupata da un agente
            if (blocked?.has(nKey)) continue;

            dist.set(nKey, d + 1);
            queue.push({ x: nb.x, y: nb.y, key: nKey });
        }
    }

    return dist;
}

// Azioni opportunistiche: a ogni passo, se mi trovo fisicamente sopra un pacco
// lo raccolgo, e se sono su una delivery tile con pacchi in mano li consegno —
// indipendentemente dall'intenzione corrente.
async function opportunisticActions(me, socket) {
    const x = Math.round(me.x), y = Math.round(me.y);

    // Pickup: c'è un pacco libero proprio qui sotto?
    for (const p of beliefs.parcels.values()) {
        if (p.carriedBy) continue;
        if (Math.round(p.x) !== x || Math.round(p.y) !== y) continue;

        const picked = await socket.emitPickup();
        if (picked && picked.length > 0) {
            beliefs.carrying       = true;
            beliefs.carriedParcels = [...beliefs.carriedParcels, ...picked];
            for (const pp of picked) beliefs.parcels.delete(pp.id);
            // console.log(`[MOVES] pickup opportunistico: ${picked.length} pacchi @ (${x},${y})`);
        }
        break;
    }

    // Delivery: sono su una delivery tile con pacchi in mano?
    if (beliefs.carrying || beliefs.carriedParcels.length > 0) {
        const onDelivery = beliefs.deliveryPoints.some(d => d.x === x && d.y === y);
        if (onDelivery) {
            const ids     = beliefs.carriedParcels.map(p => p.id);
            const dropped = await socket.emitPutdown(ids.length > 0 ? ids : undefined);
            if (dropped && dropped.length > 0) {
                beliefs.carrying       = false;
                beliefs.carriedParcels = [];
                // console.log(`[MOVES] delivery opportunistica: ${dropped.length} pacchi @ (${x},${y})`);
            }
        }
    }
}


export async function navigateTo(
    me,
    target,
    socket,
    walkableTiles,
    shouldStop  = () => false,
    retryLimit  = 3,
    opportunistic = true,   // false → niente pickup/delivery automatici lungo il
                            // percorso (serve alle missioni "drop in (x,y)": non
                            // devo consegnare il pacco passando su una delivery)
) {
    // console.log(`[MOVES] navigateTo A*: (${Math.round(me.x)},${Math.round(me.y)}) → (${target.x},${target.y})`);

    for (let attempt = 0; attempt < retryLimit; attempt++) {

        const blocked      = getBlockedCells();
        const isDirectional = beliefs.isDirectionalMap;  // ← letto internamente

        const path = aStarPath(me, target, walkableTiles, blocked, isDirectional);

        if (path === null) {
            // console.warn(`[MOVES] A*: target (${target.x},${target.y}) non raggiungibile`);
            return 'failed';
        }

        if (path.length === 0) {
            // console.log(`[MOVES] A*: già a destinazione`);
            return 'reached';
        }

        // console.log(`[MOVES] A* (tentativo ${attempt + 1}): percorso di ${path.length} passi`);

        let pathBroken = false;

        for (const nextCell of path) {

            if (shouldStop()) {
                // console.log(`[MOVES] navigateTo interrotto da shouldStop()`);
                return 'stopped';
            }

            const direction = getDirection(me, nextCell);
            if (!direction) continue;

            const result = await socket.emitMove(direction);

            if (result && result.x != null) {
                me.x = result.x;
                me.y = result.y;
                if (opportunistic) await opportunisticActions(me, socket);
            } else {
                // console.warn(`[MOVES] Passo verso ${direction} rifiutato — ricalcolo A* (tentativo ${attempt + 1})`);
                pathBroken = true;
                break;
            }
        }

        if (!pathBroken) {
            const arrived = Math.round(me.x) === Math.round(target.x) &&
                            Math.round(me.y) === Math.round(target.y);
            return arrived ? 'reached' : 'failed';
        }
    }

    // console.warn(`[MOVES] navigateTo: esauriti ${retryLimit} tentativi A*`);
    return 'failed';
}