// pddl_planner.js
// Planner PDDL per Deliveroo — parte 1 del progetto (external planner)
// Pattern: lab5 del prof + idea del `connected` precalcolato vista nel codice studente.
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
// 1. DOMAIN — una sola azione `move` + (connected ?from ?to)
//    Più pulito delle 4 azioni separate: la topologia sta nel predicato connected.
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

    return new PddlDomain('deliveroo', move, pickup, putdown);
}


// ─────────────────────────────────────────────────────────────────────────────
// 2. HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function tileId(x, y) {
    return `t_${Math.round(x)}_${Math.round(y)}`;
}

// Costruisce la lista delle adiacenze `connected` UNA VOLTA.
// Chiamala da updateMap() in beliefs.js e salva il risultato in beliefs.connections
// per non ricalcolarlo a ogni piano. Qui la lasciamo standalone per chiarezza.
export function buildConnections(mapTiles) {
    const walkable = new Map(); // "x_y" -> {x,y,type}
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


// ─────────────────────────────────────────────────────────────────────────────
// 3. PROBLEM — stato attuale (solo pacco target + agenti nemici come ostacoli)
// ─────────────────────────────────────────────────────────────────────────────

function buildDeliverooProblem(me, mapTiles, parcels, goalParcelId, enemyAgents = []) {

    const bs = new Beliefset();
    bs.declare(`me agent1`);
    bs.declare(`at agent1 ${tileId(me.x, me.y)}`);

    const { connections, deliveries } = buildConnections(mapTiles);
    for (const c of connections) bs.declare(c);
    for (const d of deliveries)  bs.declare(`delivery ${d}`);

    // Agenti nemici → ostacoli
    for (const a of enemyAgents) {
        if (typeof a.x === 'number' && !isNaN(a.x)) {
            bs.declare(`obstacle ${tileId(a.x, a.y)}`);
        }
    }

    // Solo il pacco target
    const target = parcels.get(goalParcelId);
    if (!target) throw new Error(`Pacco ${goalParcelId} non nei beliefs`);
    const pid = `p${goalParcelId}`;
    bs.declare(`parcel ${pid}`);
    bs.declare(`at ${pid} ${tileId(target.x, target.y)}`);

    return new PddlProblem(
        'deliveroo-problem',
        bs.objects.join(' '),
        bs.toPddlString(),
        `delivered ${pid}`
    );
}


// ─────────────────────────────────────────────────────────────────────────────
// 4. SOLVER — export principale
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{x:number,y:number}} me
 * @param {Map<string,{type:string}>} mapTiles
 * @param {Map<string,object>} parcels
 * @param {string} goalParcelId
 * @param {Array<{x:number,y:number}>} enemyAgents
 * @returns {Promise<Array<{action:string,args:string[]}>|null>}
 */
export async function getPddlPlan(me, mapTiles, parcels, goalParcelId, enemyAgents = []) {

    if (!PDDL_ENABLED) return null;

    let domain, problem;
    try {
        domain  = buildDeliverooDomain();
        problem = buildDeliverooProblem(me, mapTiles, parcels, goalParcelId, enemyAgents);
    } catch (err) {
         console.error('[PDDL] Errore costruzione problema:', err.message);
        return null;
    }

    // PddlDomain.toPddlString() dichiara solo (:requirements :strips), ma il
    // dominio usa (not ...) nelle precondizioni (move/obstacle) → richiede
    // :negative-preconditions, altrimenti il parser FF fallisce con un
    // criptico "syntax error ... 'define' expected".
    const domainStr = domain.toPddlString().replace(
        '(:requirements :strips)',
        '(:requirements :strips :negative-preconditions)'
    );

    let rawPlan;
    try {
        rawPlan = await Promise.race([
            onlineSolver(domainStr, problem.toPddlString()),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`timeout ${PDDL_TIMEOUT_MS}ms`)), PDDL_TIMEOUT_MS)
            ),
        ]);
    } catch (err) {
        console.warn('[PDDL] Solver fallito, fallback A*:', err.message);
        return null;
    }

    if (!rawPlan || rawPlan.length === 0) {
        console.warn('[PDDL] Nessun piano per', goalParcelId);
        return null;
    }

     console.log(`[PDDL] Piano trovato: ${rawPlan.length} passi`);
    return rawPlan;
}


// ─────────────────────────────────────────────────────────────────────────────
// 5. PIANO → MOSSE
//    Il solver restituisce action/args in UPPERCASE:
//    {action:'MOVE', args:['AGENT1','T_0_0','T_1_0']}
//    Ricaviamo la direzione confrontando le coordinate from→to.
// ─────────────────────────────────────────────────────────────────────────────

function parseCoords(tileLabel) {
    // 'T_3_4' o 't_3_4' → {x:3, y:4}
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
            if (to.x > from.x) moves.push('right');
            else if (to.x < from.x) moves.push('left');
            else if (to.y > from.y) moves.push('up');
            else if (to.y < from.y) moves.push('down');
        }
    }
    return moves;
}
