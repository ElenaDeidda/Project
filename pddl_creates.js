// pddl_creates.js
// Planner PDDL per mappe con casse (tile tipo '5!').
// Le stringhe domain e problem sono generate manualmente: la libreria
// PddlDomain/PddlAction genera predicati duplicati e sovrascrive il nome
// del dominio con 'default', producendo PDDL malformato.
// Qui usiamo solo onlineSolver dalla libreria.

import { onlineSolver } from '@unitn-asa/pddl-client';

const PDDL_TIMEOUT_MS = 5000;

// ─────────────────────────────────────────────────────────────────────────────
// 1. HELPERS
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
// 2. DOMAIN — stringa PDDL fissa
// ─────────────────────────────────────────────────────────────────────────────

function domainPddl() {
    return `(define (domain crate-world)
  (:requirements :strips)
  (:predicates
    (me ?a)
    (at ?a ?b)
    (connected ?a ?b)
    (right ?a ?b)
    (left ?a ?b)
    (up ?a ?b)
    (down ?a ?b)
    (crate-at ?a)
    (crate-slot ?a)
  )
  (:action move
    :parameters (?me ?from ?to)
    :precondition (and (me ?me) (at ?me ?from) (connected ?from ?to) (not (crate-at ?to)))
    :effect (and (at ?me ?to) (not (at ?me ?from)))
  )
  (:action push-right
    :parameters (?me ?from ?crate ?behind)
    :precondition (and (me ?me) (at ?me ?from) (right ?from ?crate) (crate-at ?crate) (right ?crate ?behind) (crate-slot ?behind) (not (crate-at ?behind)))
    :effect (and (at ?me ?crate) (not (at ?me ?from)) (crate-at ?behind) (not (crate-at ?crate)))
  )
  (:action push-left
    :parameters (?me ?from ?crate ?behind)
    :precondition (and (me ?me) (at ?me ?from) (left ?from ?crate) (crate-at ?crate) (left ?crate ?behind) (crate-slot ?behind) (not (crate-at ?behind)))
    :effect (and (at ?me ?crate) (not (at ?me ?from)) (crate-at ?behind) (not (crate-at ?crate)))
  )
  (:action push-up
    :parameters (?me ?from ?crate ?behind)
    :precondition (and (me ?me) (at ?me ?from) (up ?from ?crate) (crate-at ?crate) (up ?crate ?behind) (crate-slot ?behind) (not (crate-at ?behind)))
    :effect (and (at ?me ?crate) (not (at ?me ?from)) (crate-at ?behind) (not (crate-at ?crate)))
  )
  (:action push-down
    :parameters (?me ?from ?crate ?behind)
    :precondition (and (me ?me) (at ?me ?from) (down ?from ?crate) (crate-at ?crate) (down ?crate ?behind) (crate-slot ?behind) (not (crate-at ?behind)))
    :effect (and (at ?me ?crate) (not (at ?me ?from)) (crate-at ?behind) (not (crate-at ?crate)))
  )
)`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. PROBLEM — stringa PDDL generata dallo stato attuale
// ─────────────────────────────────────────────────────────────────────────────

function problemPddl(beliefs, targetX, targetY) {
    const agentKey = `${Math.round(beliefs.me.x)}_${Math.round(beliefs.me.y)}`;
    const objects  = new Set(['agent1']);
    const facts    = [];

    // Agente
    const agentTile = tileId(beliefs.me.x, beliefs.me.y);
    objects.add(agentTile);
    facts.push(`(me agent1)`);
    facts.push(`(at agent1 ${agentTile})`);

    // Casse: escludi la posizione dell'agente (stato iniziale contraddittorio)
    for (const [key, pos] of beliefs.crateTiles.entries()) {
        if (key === agentKey) continue;
        const tid = tileId(pos.x, pos.y);
        objects.add(tid);
        facts.push(`(crate-at ${tid})`);
    }

    // Adiacenze: connected (per MOVE) + direzionali right/left/up/down (per PUSH)
    for (const [key, tile] of beliefs.mapTiles.entries()) {
        if (tile.type === '0') continue;
        const [x, y] = key.split('_').map(Number);
        const from = tileId(x, y);
        objects.add(from);

        const adj = [
            { nx: x + 1, ny: y,     dir: 'right' },
            { nx: x - 1, ny: y,     dir: 'left'  },
            { nx: x,     ny: y + 1, dir: 'up'    },
            { nx: x,     ny: y - 1, dir: 'down'  },
        ];

        for (const { nx, ny, dir } of adj) {
            const nTile = beliefs.mapTiles.get(`${nx}_${ny}`);
            if (!nTile || nTile.type === '0') continue;
            const to = tileId(nx, ny);
            objects.add(to);
            facts.push(`(connected ${from} ${to})`);
            facts.push(`(${dir} ${from} ${to})`);
        }
    }

    // Slot cassa: tile valide come destinazione di push ('5' e '5!')
    for (const [key, tile] of beliefs.mapTiles.entries()) {
        if (tile.type !== '5' && tile.type !== '5!') continue;
        const [x, y] = key.split('_').map(Number);
        const tid = tileId(x, y);
        objects.add(tid);
        facts.push(`(crate-slot ${tid})`);
    }

    const targetTile = tileId(targetX, targetY);
    objects.add(targetTile);

    return `(define (problem crate-problem)
  (:domain crate-world)
  (:objects ${[...objects].join(' ')})
  (:init
    ${facts.join('\n    ')}
  )
  (:goal (at agent1 ${targetTile}))
)`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. SOLVER — export principale
// ─────────────────────────────────────────────────────────────────────────────

export async function solveCratePath(beliefs, targetX, targetY) {
    const domainStr  = domainPddl();
    const problemStr = problemPddl(beliefs, targetX, targetY);

    try {
        const rawPlan = await Promise.race([
            onlineSolver(domainStr, problemStr),
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
