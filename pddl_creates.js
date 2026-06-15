// pddl_creates.js
// Planner PDDL per mappe con casse (tile tipo '5!').
// Il dominio viene generato come stringa (PddlDomain/PddlAction duplica i predicati
// per le azioni push, producendo PDDL malformato).
// Il problema usa Beliefset + PddlProblem dalla libreria, con fix critico:
// PddlProblem.toPddlString() aggiunge già (:goal (...)) → il goal si passa SENZA parens.

import { onlineSolver, PddlProblem, Beliefset } from '@unitn-asa/pddl-client';

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
// 2. DOMAIN — stringa PDDL fissa (PddlDomain/PddlAction non usati: duplicano
//    predicati come 'right' che compaiono due volte nella stessa precondizione)
// ─────────────────────────────────────────────────────────────────────────────

function domainPddl() {
    return `(define (domain default)
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
// 3. PROBLEM — costruito con Beliefset + PddlProblem dalla libreria
// ─────────────────────────────────────────────────────────────────────────────

function buildCrateProblem(beliefs, targetX, targetY) {
    const agentKey = `${Math.round(beliefs.me.x)}_${Math.round(beliefs.me.y)}`;
    const bs = new Beliefset();

    // Agente
    bs.declare(`me agent1`);
    bs.declare(`at agent1 ${tileId(beliefs.me.x, beliefs.me.y)}`);

    // Casse: escludi la posizione dell'agente (stato iniziale contraddittorio)
    for (const [key, pos] of beliefs.crateTiles.entries()) {
        if (key === agentKey) continue;
        bs.declare(`crate-at ${tileId(pos.x, pos.y)}`);
    }

    // Adiacenze: connected (per MOVE) + direzionali right/left/up/down (per PUSH)
    for (const [key, tile] of beliefs.mapTiles.entries()) {
        if (tile.type === '0') continue;
        const [x, y] = key.split('_').map(Number);
        const from = tileId(x, y);

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
            bs.declare(`connected ${from} ${to}`);
            bs.declare(`${dir} ${from} ${to}`);
        }
    }

    // Slot cassa: tile valide come destinazione di push ('5' e '5!')
    for (const [key, tile] of beliefs.mapTiles.entries()) {
        if (tile.type !== '5' && tile.type !== '5!') continue;
        const [x, y] = key.split('_').map(Number);
        bs.declare(`crate-slot ${tileId(x, y)}`);
    }

    // NOTA: PddlProblem.toPddlString() genera (:goal (${goals})) — aggiunge già le
    // parentesi esterne. Il goal va passato SENZA parentesi esterne per evitare ((goal)).
    return new PddlProblem(
        'crate-problem',
        bs.objects.join(' '),
        bs.toPddlString(),
        `at agent1 ${tileId(targetX, targetY)}`
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. SOLVER — export principale
// ─────────────────────────────────────────────────────────────────────────────

export async function solveCratePath(beliefs, targetX, targetY) {
    const domainStr = domainPddl();
    const problem   = buildCrateProblem(beliefs, targetX, targetY);

    try {
        const rawPlan = await Promise.race([
            onlineSolver(domainStr, problem.toPddlString()),
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
