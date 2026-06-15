// pddl_creates.js
// Planner PDDL per mappe con casse (tile tipo '5!').
// Domain: MOVE + 4 azioni PUSH direzionali (push-right/left/up/down).
// Elimina same-dir (3 argomenti → problemi con Beliefset) e obstacle (ridondante).
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
        'and (me ?me) (at ?me ?from) (connected ?from ?to) (not (crate-at ?to))',
        'and (at ?me ?to) (not (at ?me ?from))'
    );

    // 4 push direzionali: ogni azione usa predicati right/left/up/down (2 argomenti)
    // anziché same-dir (3 argomenti) che causava syntax error nel toPddlString()
    const pushRight = new PddlAction(
        'push-right',
        '?me ?from ?crate ?behind',
        'and (me ?me) (at ?me ?from) (right ?from ?crate) (crate-at ?crate) (right ?crate ?behind) (crate-slot ?behind) (not (crate-at ?behind))',
        'and (at ?me ?crate) (not (at ?me ?from)) (crate-at ?behind) (not (crate-at ?crate))'
    );

    const pushLeft = new PddlAction(
        'push-left',
        '?me ?from ?crate ?behind',
        'and (me ?me) (at ?me ?from) (left ?from ?crate) (crate-at ?crate) (left ?crate ?behind) (crate-slot ?behind) (not (crate-at ?behind))',
        'and (at ?me ?crate) (not (at ?me ?from)) (crate-at ?behind) (not (crate-at ?crate))'
    );

    const pushUp = new PddlAction(
        'push-up',
        '?me ?from ?crate ?behind',
        'and (me ?me) (at ?me ?from) (up ?from ?crate) (crate-at ?crate) (up ?crate ?behind) (crate-slot ?behind) (not (crate-at ?behind))',
        'and (at ?me ?crate) (not (at ?me ?from)) (crate-at ?behind) (not (crate-at ?crate))'
    );

    const pushDown = new PddlAction(
        'push-down',
        '?me ?from ?crate ?behind',
        'and (me ?me) (at ?me ?from) (down ?from ?crate) (crate-at ?crate) (down ?crate ?behind) (crate-slot ?behind) (not (crate-at ?behind))',
        'and (at ?me ?crate) (not (at ?me ?from)) (crate-at ?behind) (not (crate-at ?crate))'
    );

    return new PddlDomain('crate-world', move, pushRight, pushLeft, pushUp, pushDown);
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

    // Casse: escludi la posizione dell'agente.
    // Se la mappa iniziale ha una '5!' dove l'agente spawna, il server ha già
    // risolto la collisione lato suo — non dichiarare crate-at lì o il planner
    // parte da uno stato iniziale contraddittorio e non trova mai un piano.
    const agentKey = `${Math.round(beliefs.me.x)}_${Math.round(beliefs.me.y)}`;
    for (const [key, pos] of beliefs.crateTiles.entries()) {
        if (key === agentKey) continue;
        bs.declare(`crate-at ${tileId(pos.x, pos.y)}`);
    }

    // connected (per MOVE) + right/left/up/down (per PUSH): solo tra tile non-muro
    for (const [key, tile] of beliefs.mapTiles.entries()) {
        if (tile.type === '0') continue;
        const [x, y] = key.split('_').map(Number);

        const adj = [
            { nx: x + 1, ny: y,     dir: 'right' },
            { nx: x - 1, ny: y,     dir: 'left'  },
            { nx: x,     ny: y + 1, dir: 'up'    },
            { nx: x,     ny: y - 1, dir: 'down'  },
        ];

        for (const { nx, ny, dir } of adj) {
            const nTile = beliefs.mapTiles.get(`${nx}_${ny}`);
            if (!nTile || nTile.type === '0') continue;
            bs.declare(`connected ${tileId(x, y)} ${tileId(nx, ny)}`);
            bs.declare(`${dir} ${tileId(x, y)} ${tileId(nx, ny)}`);
        }
    }

    // crate-slot: tile valide come destinazione di push ('5' vuota e '5!' occupata)
    for (const [key, tile] of beliefs.mapTiles.entries()) {
        if (tile.type === '5' || tile.type === '5!') {
            const [x, y] = key.split('_').map(Number);
            bs.declare(`crate-slot ${tileId(x, y)}`);
        }
    }

    return new PddlProblem(
        'crate-problem',
        bs.objects.join(' '),
        bs.toPddlString(),
        `(at agent1 ${tileId(targetX, targetY)})`
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. SOLVER — export principale
// ─────────────────────────────────────────────────────────────────────────────

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

const PUSH_ACTIONS = new Set(['push-right', 'push-left', 'push-up', 'push-down']);

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

        if (PUSH_ACTIONS.has(act)) {
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
