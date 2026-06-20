import { getDirection } from './basic_functions.js';
import { getBlockedCells, beliefs, deliverableIds } from './beliefs.js';

function heuristic(a, b) {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}


class MinHeap {
    #data = [];
    get size() { return this.#data.length; }

    push(item) {
        const a = this.#data;
        a.push(item);
        let i = a.length - 1;
        while (i > 0) {                       // sift-up: risale finché < del padre
            const p = (i - 1) >> 1;
            if (a[p].f <= a[i].f) break;
            [a[p], a[i]] = [a[i], a[p]];
            i = p;
        }
    }

    pop() {
        const a = this.#data;
        if (a.length === 0) return undefined;
        const top = a[0];                     // il minimo è sempre in cima
        const last = a.pop();
        if (a.length > 0) {
            a[0] = last;
            let i = 0;
            const n = a.length;
            while (true) {                    // sift-down: scende verso il figlio minore
                const l = 2*i + 1, r = 2*i + 2;
                let m = i;
                if (l < n && a[l].f < a[m].f) m = l;
                if (r < n && a[r].f < a[m].f) m = r;
                if (m === i) break;
                [a[i], a[m]] = [a[m], a[i]];
                i = m;
            }
        }
        return top;
    }
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
            if (tile.type === '5!') continue; // cassa = muro per A*

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

// BFS single-source: distanza reale di percorso da `start` a tutte le celle
// raggiungibili (rispetta muri, vincoli direzionali, celle bloccate). Ritorna
// Map "x_y" → distanza; celle assenti = irraggiungibili (∞).
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

            // Vincolo direzionale (stessa logica dell'A*)
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

    // Pickup: c'è un pacco libero qui sotto?
    // Cap stack_size=N: se porto già N pacchi non raccolgo l'(N+1)-esimo mentre
    // vado a consegnare. (Con max_deliver_reward accumulo fino a capacity.)
    const Ncap = beliefs.activeRules?.stackSize;
    const stackCapReached = Number.isInteger(Ncap)
        && typeof beliefs.activeRules?.maxDeliverReward !== 'number'
        && beliefs.carriedParcels.length >= Ncap;
    // Staffetta: se sono il raccoglitore e questa è la tile di handover dove ho
    // appena ceduto i pacchi, NON li riprendo automaticamente (li aspetta il postino).
    const c = beliefs.coord;
    const relayReserved = c?.role === 'collector' && c?._relayBusy && c?._dropTile
        && x === c._dropTile.x && y === c._dropTile.y;
    if (!stackCapReached && !relayReserved)
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
        // Staffetta: il RACCOGLITORE non consegna MAI da solo (passa dal postino),
        // altrimenti il bonus "preso da uno, consegnato dall'altro" non scatta.
        if (beliefs.coord?.role === 'collector') return;
        const onDelivery = beliefs.deliveryPoints.some(d => d.x === x && d.y === y);
        if (onDelivery) {
            // stack_size puro: non consegno un parziale mentre passo (aspetto N).
            // Con max_deliver_reward i pacchi ≤ soglia sono pronti → li consegno.
            const N = beliefs.activeRules?.stackSize;
            const hasMaxDeliver = typeof beliefs.activeRules?.maxDeliverReward === 'number';
            if (Number.isInteger(N) && !hasMaxDeliver && beliefs.carriedParcels.length < N) return;

            const ids = deliverableIds(beliefs);   // rispetta max_deliver_reward + stack_size
            if (ids.length === 0) return;
            const dropped = await socket.emitPutdown(ids);
            if (dropped && dropped.length > 0) {
                const set = new Set(ids);
                beliefs.carriedParcels = beliefs.carriedParcels.filter(p => !set.has(p.id));
                beliefs.carrying = beliefs.carriedParcels.length > 0;
                console.log(`[OPP] delivery automatica: ${dropped.length} pacchi @ (${x},${y}) (restano ${beliefs.carriedParcels.length})`);
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
                await opportunisticActions(me, socket);
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