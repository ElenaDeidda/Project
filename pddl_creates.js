// pddl_creates.js
// Planner PDDL per mappe con casse (tile tipo '5!').
// Domain: MOVE (navigazione libera) + PUSH (spingere una cassa).
// Goal: raggiungere una tile target — pickup e putdown restano lato BDI.

import {
    onlineSolver,
    PddlDomain,
    PddlAction,
    PddlProblem,
    Beliefset,
} from '@unitn-asa/pddl-client';

const PDDL_TIMEOUT_MS = 5000;

// ─────────────────────────────────────────────────────────────────────────────
// 1. DOMAIN
// ─────────────────────────────────────────────────────────────────────────────

function buildCrateDomain() {
    const move = new PddlAction(
        'move',
        '?me ?from ?to',
        'and (me ?me) (at ?me ?from) (connected ?from ?to) (not (crate-at ?to)) (not (obstacle ?to))',
        'and (at ?me ?to) (not (at ?me ?from))'
    );

    const push = new PddlAction(
        'push',
        '?me ?from ?crate ?behind',
        'and (me ?me) (at ?me ?from) (connected ?from ?crate) (crate-at ?crate) (connected ?crate ?behind) (same-dir ?from ?crate ?behind) (not (crate-at ?behind)) (not (obstacle ?behind))',
        'and (at ?me ?crate) (not (at ?me ?from)) (crate-at ?behind) (not (crate-at ?crate))'
    );

    return new PddlDomain('crate-world', move, push);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function tileId(x, y) {
    return `t_${Math.round(x)}_${Math.round(y)}`;
}

function parseCoords(label) {
    const m = label.toLowerCase().match(/t_(-?\d+)_(-?\d+)/);
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

function directionBetween(from, to) {
    if (to.x > from.x) return 'right';
    if (to.x < from.x) return 'left';
    if (to.y > from.y) return 'up';
    if (to.y < from.y) return 'down';
    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. PROBLEM
// ─────────────────────────────────────────────────────────────────────────────

function buildCrateProblem(beliefs, targetX, targetY) {
    const bs = new Beliefset();

    bs.declare(`me agent1`);
    bs.declare(`at agent1 ${tileId(beliefs.me.x, beliefs.me.y)}`);

    // Posizioni casse correnti
    for (const pos of beliefs.crateTiles.values()) {
        bs.declare(`crate-at ${tileId(pos.x, pos.y)}`);
    }

    // Adiacenze (connected) e ostacoli (obstacle) dalla mappa
    for (const [key, tile] of beliefs.mapTiles.entries()) {
        if (tile.type === '0') {
            const [x, y] = key.split('_').map(Number);
            bs.declare(`obstacle ${tileId(x, y)}`);
            continue;
        }

        const [x, y] = key.split('_').map(Number);
        const neighbors = [
            [x + 1, y], [x - 1, y],
            [x, y + 1], [x, y - 1],
        ];
        for (const [nx, ny] of neighbors) {
            const nTile = beliefs.mapTiles.get(`${nx}_${ny}`);
            if (nTile) {
                bs.declare(`connected ${tileId(x, y)} ${tileId(nx, ny)}`);
            }
        }
    }

    // same-dir: triplette A→B→C allineate (B-A == C-B) necessarie per l'azione PUSH
    for (const [key, tile] of beliefs.mapTiles.entries()) {
        if (tile.type === '0') continue;
        const [ax, ay] = key.split('_').map(Number);

        const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (const [dx, dy] of dirs) {
            const bx = ax + dx, by = ay + dy;
            const cx = bx + dx, cy = by + dy;
            if (!beliefs.mapTiles.has(`${bx}_${by}`)) continue;
            if (!beliefs.mapTiles.has(`${cx}_${cy}`)) continue;
            if (beliefs.mapTiles.get(`${bx}_${by}`)?.type === '0') continue;
            if (beliefs.mapTiles.get(`${cx}_${cy}`)?.type === '0') continue;
            bs.declare(`same-dir ${tileId(ax, ay)} ${tileId(bx, by)} ${tileId(cx, cy)}`);
        }
    }

    const goal = `(at agent1 ${tileId(targetX, targetY)})`;

    return new PddlProblem(
        'crate-problem',
        bs.objects.join(' '),
        bs.toPddlString(),
        goal
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. SOLVER — export principale
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Risolve il percorso verso (targetX, targetY) su una crate map.
 * @returns {Promise<Array<{action:string,args:string[]}>|null>}
 */
export async function solveCratePath(beliefs, targetX, targetY) {
    let domain, problem;
    try {
        domain  = buildCrateDomain();
        problem = buildCrateProblem(beliefs, targetX, targetY);
    } catch (err) {
        console.error('[PDDL_CREATES] Errore costruzione problema:', err.message);
        return null;
    }

    try {
        const rawPlan = await Promise.race([
            onlineSolver(domain.toPddlString(), problem.toPddlString()),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`timeout ${PDDL_TIMEOUT_MS}ms`)), PDDL_TIMEOUT_MS)
            ),
        ]);
        if (!rawPlan || rawPlan.length === 0) {
            console.warn('[PDDL_CREATES] Nessun piano verso', targetX, targetY);
            return null;
        }
        console.log(`[PDDL_CREATES] Piano trovato: ${rawPlan.length} passi`);
        return rawPlan;
    } catch (err) {
        console.warn('[PDDL_CREATES] Solver fallito:', err.message);
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. PIANO → SEQUENZA MOSSE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converte i passi PDDL in un array di {direction, isPush, crateFrom?, crateTo?}.
 * - MOVE(agent, from, to)          → {direction, isPush: false}
 * - PUSH(agent, from, crate, behind) → {direction, isPush: true, crateFrom, crateTo}
 */
export function planToMoveSequence(planSteps) {
    const moves = [];
    for (const step of planSteps) {
        const act = step.action.toLowerCase();

        if (act === 'move') {
            const from = parseCoords(step.args[1]);
            const to   = parseCoords(step.args[2]);
            if (!from || !to) continue;
            const direction = directionBetween(from, to);
            if (direction) moves.push({ direction, isPush: false });
        }

        if (act === 'push') {
            // args: [agent, from, crate, behind]
            const from    = parseCoords(step.args[1]);
            const crateAt = parseCoords(step.args[2]);
            const behind  = parseCoords(step.args[3]);
            if (!from || !crateAt || !behind) continue;
            const direction = directionBetween(from, crateAt);
            if (direction) moves.push({
                direction,
                isPush:    true,
                crateFrom: crateAt,
                crateTo:   behind,
            });
        }
    }
    return moves;
}
