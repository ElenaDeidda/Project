// pddl_planner.js
// Planner PDDL per Deliveroo — parte 1 del progetto (external planner)
//
// ATTIVAZIONE (.env):  USE_PDDL=true  → tenta PDDL ; false → sempre A*
// Se il solver va in timeout o fallisce → ritorna null → il chiamante usa A*.

import dotenv from 'dotenv';
dotenv.config();

import {
    onlineSolver,
    PddlDomain,
    PddlAction,
    PddlProblem,
    Beliefset,
} from "@unitn-asa/pddl-client";

export const PDDL_ENABLED = process.env.USE_PDDL === 'true';
console.log(`[PDDL] ${PDDL_ENABLED ? '✅ ATTIVO' : '❌ disabilitato — uso A*'}`);

const PDDL_TIMEOUT_MS = 3000;


// ─────────────────────────────────────────────────────────────────────────────
// 1. DOMAIN — move + pickup + putdown
// ─────────────────────────────────────────────────────────────────────────────

function buildDeliverooDomain() {

    const move = new PddlAction(
        'move',
        '?me ?from ?to',
        'and (me ?me) (at ?me ?from) (connected ?from ?to) (not (obstacle ?to))',
        'and (at ?me ?to) (not (at ?me ?from))'
    );

    const pickup = new PddlAction(
        'pickup',
        '?me ?p ?t',
        'and (me ?me) (at ?me ?t) (parcel ?p) (at ?p ?t)',
        'and (carrying ?me ?p) (not (at ?p ?t))'
    );

    const putdown = new PddlAction(
        'putdown',
        '?me ?p ?t',
        'and (me ?me) (at ?me ?t) (carrying ?me ?p) (delivery ?t)',
        'and (delivered ?p) (not (carrying ?me ?p))'
    );

    const domain = new PddlDomain('deliveroo', move, pickup, putdown);

    // PddlDomain deduplicates predicates by exact string, so the same predicate
    // with different variable names (e.g. "at ?me ?from" vs "at ?me ?t") ends up
    // declared multiple times. Keep only the first occurrence of each predicate name.
    const seen = new Set();
    domain.predicates = domain.predicates.filter(p => {
        const name = p.split(' ')[0];
        if (seen.has(name)) return false;
        seen.add(name);
        return true;
    });

    return domain;
}


// ─────────────────────────────────────────────────────────────────────────────
// 2. HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function tileId(x, y) {
    return `t_${Math.round(x)}_${Math.round(y)}`;
}

export function buildConnections(mapTiles) {
    const walkable = new Map();
    for (const [key, tile] of mapTiles.entries()) {
        if (String(tile.type) === '0') continue;
        const [x, y] = key.split('_').map(Number);
        walkable.set(`${x}_${y}`, { x, y, type: String(tile.type) });
    }

    const connections = [];
    const deliveries  = [];
    for (const t of walkable.values()) {
        const id = tileId(t.x, t.y);
        if (t.type === '2') deliveries.push(id);

        const neigh = [
            [t.x + 1, t.y], [t.x - 1, t.y],
            [t.x, t.y + 1], [t.x, t.y - 1],
        ];
        for (const [nx, ny] of neigh) {
            if (walkable.has(`${nx}_${ny}`)) {
                connections.push(`connected ${id} ${tileId(nx, ny)}`);
            }
        }
    }
    return { connections, deliveries };
}

// Dichiara la topologia della mappa in un Beliefset (condivisa dai 3 problem builder)
function declareMapBase(bs, me, mapTiles, enemyAgents = []) {
    bs.declare(`me agent1`);
    bs.declare(`at agent1 ${tileId(me.x, me.y)}`);

    const { connections, deliveries } = buildConnections(mapTiles);
    for (const c of connections) bs.declare(c);
    for (const d of deliveries)  bs.declare(`delivery ${d}`);

    for (const a of enemyAgents) {
        if (typeof a.x === 'number' && !isNaN(a.x)) {
            bs.declare(`obstacle ${tileId(a.x, a.y)}`);
        }
    }

    return { deliveries };
}


// ─────────────────────────────────────────────────────────────────────────────
// 3a. PROBLEM per GoPickUp
//     Goal: (carrying agent1 pid)  ← solo raggiungi e raccogli
// ─────────────────────────────────────────────────────────────────────────────

function buildPickupProblem(me, mapTiles, parcels, goalParcelId, enemyAgents = []) {
    const bs = new Beliefset();
    declareMapBase(bs, me, mapTiles, enemyAgents);

    const target = parcels.get(goalParcelId);
    if (!target) throw new Error(`Pacco ${goalParcelId} non nei beliefs`);
    const pid = `p${goalParcelId}`;
    bs.declare(`parcel ${pid}`);
    bs.declare(`at ${pid} ${tileId(target.x, target.y)}`);

    return new PddlProblem(
        'deliveroo-pickup',
        bs.objects.join(' '),
        bs.toPddlString(),
        `carrying agent1 ${pid}`
    );
}


// ─────────────────────────────────────────────────────────────────────────────
// 3b. PROBLEM per Deliver
//     Goal: (at agent1 targetTile)  ← raggiungi la delivery tile
//     Nota: il putdown lo fa plans.js dopo l'arrivo, uguale al GoPickUp.
//           Non mettiamo putdown nel goal per evitare che il planner cerchi
//           i predicati (carrying ?me ?p) che non sa quali siano.
// ─────────────────────────────────────────────────────────────────────────────

function buildDeliverProblem(me, mapTiles, targetX, targetY, enemyAgents = []) {
    const bs = new Beliefset();
    declareMapBase(bs, me, mapTiles, enemyAgents);

    const dest = tileId(targetX, targetY);

    return new PddlProblem(
        'deliveroo-deliver',
        bs.objects.join(' '),
        bs.toPddlString(),
        `at agent1 ${dest}`
    );
}


// ─────────────────────────────────────────────────────────────────────────────
// 3c. PROBLEM per GoToSpawn
//     Goal: (at agent1 targetTile)  ← raggiungi la spawn tile
// ─────────────────────────────────────────────────────────────────────────────

function buildSpawnProblem(me, mapTiles, targetX, targetY, enemyAgents = []) {
    const bs = new Beliefset();
    declareMapBase(bs, me, mapTiles, enemyAgents);

    const dest = tileId(targetX, targetY);

    return new PddlProblem(
        'deliveroo-spawn',
        bs.objects.join(' '),
        bs.toPddlString(),
        `at agent1 ${dest}`
    );
}


// ─────────────────────────────────────────────────────────────────────────────
// 4. SOLVER — funzione generica interna
// ─────────────────────────────────────────────────────────────────────────────

async function solveWithTimeout(domain, problem, label) {
    let rawPlan;
    try {
        rawPlan = await Promise.race([
            onlineSolver(domain.toPddlString(), problem.toPddlString()),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`timeout ${PDDL_TIMEOUT_MS}ms`)), PDDL_TIMEOUT_MS)
            ),
        ]);
    } catch (err) {
        console.warn(`[PDDL] ${label} — Solver fallito, fallback A*:`, err.message);
        return null;
    }

    if (!rawPlan || rawPlan.length === 0) {
        console.warn(`[PDDL] ${label} — Nessun piano trovato`);
        return null;
    }

    console.log(`[PDDL] ${label} — Piano trovato: ${rawPlan.length} passi`);
    return rawPlan;
}


// ─────────────────────────────────────────────────────────────────────────────
// 5. EXPORT PRINCIPALI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Piano per raccogliere un pacco (GoPickUp).
 * Goal PDDL: (carrying agent1 pid)
 */
export async function getPddlPlan(me, mapTiles, parcels, goalParcelId, enemyAgents = []) {
    if (!PDDL_ENABLED) return null;

    let domain, problem;
    try {
        domain  = buildDeliverooDomain();
        problem = buildPickupProblem(me, mapTiles, parcels, goalParcelId, enemyAgents);
    } catch (err) {
        console.error('[PDDL] GoPickUp — Errore costruzione problema:', err.message);
        return null;
    }

    return solveWithTimeout(domain, problem, `GoPickUp(${goalParcelId})`);
}

/**
 * Piano per raggiungere una delivery tile (Deliver).
 * Goal PDDL: (at agent1 t_X_Y)
 */
export async function getPddlPlanDeliver(me, mapTiles, targetX, targetY, enemyAgents = []) {
    if (!PDDL_ENABLED) return null;

    let domain, problem;
    try {
        domain  = buildDeliverooDomain();
        problem = buildDeliverProblem(me, mapTiles, targetX, targetY, enemyAgents);
    } catch (err) {
        console.error('[PDDL] Deliver — Errore costruzione problema:', err.message);
        return null;
    }

    return solveWithTimeout(domain, problem, `Deliver(${targetX},${targetY})`);
}

/**
 * Piano per raggiungere una spawn tile (GoToSpawn).
 * Goal PDDL: (at agent1 t_X_Y)
 */
export async function getPddlPlanSpawn(me, mapTiles, targetX, targetY, enemyAgents = []) {
    if (!PDDL_ENABLED) return null;

    let domain, problem;
    try {
        domain  = buildDeliverooDomain();
        problem = buildSpawnProblem(me, mapTiles, targetX, targetY, enemyAgents);
    } catch (err) {
        console.error('[PDDL] GoToSpawn — Errore costruzione problema:', err.message);
        return null;
    }

    return solveWithTimeout(domain, problem, `GoToSpawn(${targetX},${targetY})`);
}


// ─────────────────────────────────────────────────────────────────────────────
// 6. PIANO → MOSSE
//    Il solver restituisce action/args in UPPERCASE:
//    {action:'MOVE', args:['AGENT1','T_0_0','T_1_0']}
//    Ricaviamo la direzione confrontando le coordinate from→to.
// ─────────────────────────────────────────────────────────────────────────────

function parseCoords(tileLabel) {
    const m = tileLabel.toLowerCase().match(/t_(\d+)_(\d+)/);
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

export function planToMoves(plan) {
    const moves = [];
    for (const step of plan) {
        const act = step.action.toLowerCase();

        if (act === 'pickup')  { moves.push('pickup');  continue; }
        if (act === 'putdown') { moves.push('putdown'); continue; }

        if (act === 'move') {
            const from = parseCoords(step.args[1]);
            const to   = parseCoords(step.args[2]);
            if (!from || !to) continue;
            if (to.x > from.x)      moves.push('right');
            else if (to.x < from.x) moves.push('left');
            else if (to.y > from.y) moves.push('up');
            else if (to.y < from.y) moves.push('down');
        }
    }
    return moves;
}
