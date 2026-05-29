import { onlineSolver, PddlDomain, PddlAction, PddlProblem, Beliefset } from "@unitn-asa/pddl-client";

/**
 * PDDL Planner per il progetto Deliveroo
 * 
 * Usa il solver online su solver.planning.domains (nessuna config necessaria).
 * 
 * Come integrarlo nel tuo agente:
 *   import { getPddlPlan } from './pddlPlanner.js';
 * 
 *   const plan = await getPddlPlan(me, map, parcels, deliveryZones);
 *   for (const step of plan) {
 *       await client.move(step.action);   // 'right' | 'left' | 'up' | 'down'
 *   }
 */


// ─────────────────────────────────────────────
// 1. DOMAIN: definisce le azioni possibili
// ─────────────────────────────────────────────

/**
 * Crea il dominio PDDL con le 4 azioni di movimento + pickup + putdown.
 * @returns {PddlDomain}
 */
function buildDeliverooDomain() {

    const moveRight = new PddlAction(
        'move_right',
        '?me ?from ?to',
        'and (me ?me) (at ?me ?from) (right ?from ?to)',
        'and (at ?me ?to) (not (at ?me ?from))'
    );

    const moveLeft = new PddlAction(
        'move_left',
        '?me ?from ?to',
        'and (me ?me) (at ?me ?from) (left ?from ?to)',
        'and (at ?me ?to) (not (at ?me ?from))'
    );

    const moveUp = new PddlAction(
        'move_up',
        '?me ?from ?to',
        'and (me ?me) (at ?me ?from) (up ?from ?to)',
        'and (at ?me ?to) (not (at ?me ?from))'
    );

    const moveDown = new PddlAction(
        'move_down',
        '?me ?from ?to',
        'and (me ?me) (at ?me ?from) (down ?from ?to)',
        'and (at ?me ?to) (not (at ?me ?from))'
    );

    const pickup = new PddlAction(
        'pickup',
        '?me ?p ?t',
        'and (me ?me) (at ?me ?t) (at ?p ?t) (parcel ?p)',
        'and (carrying ?me ?p) (not (at ?p ?t))'
    );

    const putdown = new PddlAction(
        'putdown',
        '?me ?p ?t',
        'and (me ?me) (at ?me ?t) (carrying ?me ?p) (delivery ?t)',
        'and (at ?p ?t) (not (carrying ?me ?p)) (delivered ?p)'
    );

    return new PddlDomain('deliveroo', moveRight, moveLeft, moveUp, moveDown, pickup, putdown);
}


// ─────────────────────────────────────────────
// 2. PROBLEM: costruisce lo stato attuale
// ─────────────────────────────────────────────

/**
 * Converte coordinate (x, y) in un identificatore PDDL sicuro.
 * Es: tileId(3, 2) → 't3_2'
 */
function tileId(x, y) {
    return `t${x}_${y}`;
}

/**
 * Costruisce il problema PDDL a partire dalle credenze dell'agente.
 * 
 * @param {{ x: number, y: number, id: string }} me         - posizione e id agente
 * @param {Array<{ x: number, y: number, type: string }>} mapTiles - tutte le celle della mappa
 * @param {Array<{ id: string, x: number, y: number }>} parcels  - pacchi visibili (non ancora consegnati)
 * @param {string} goalParcelId                                   - id del pacco da raccogliere/consegnare
 * @returns {PddlProblem}
 */
function buildDeliverooProblem(me, mapTiles, parcels, goalParcelId) {

    const beliefs = new Beliefset();

    // Agente
    beliefs.declare(`me agent1`);
    beliefs.declare(`agent agent1`);
    beliefs.declare(`at agent1 ${tileId(me.x, me.y)}`);

    // Tiles e adiacenze
    const walkable = mapTiles.filter(t => t.type !== '0'); // '0' = wall

    for (const tile of walkable) {
        const id = tileId(tile.x, tile.y);
        beliefs.declare(`tile ${id}`);

        // Delivery zone
        if (tile.type === '2') {
            beliefs.declare(`delivery ${id}`);
        }

        // Adiacenze cardinali
        const right = walkable.find(t => t.x === tile.x + 1 && t.y === tile.y);
        if (right) beliefs.declare(`right ${id} ${tileId(right.x, right.y)}`);

        const left = walkable.find(t => t.x === tile.x - 1 && t.y === tile.y);
        if (left) beliefs.declare(`left ${id} ${tileId(left.x, left.y)}`);

        const up = walkable.find(t => t.x === tile.x && t.y === tile.y + 1);
        if (up) beliefs.declare(`up ${id} ${tileId(up.x, up.y)}`);

        const down = walkable.find(t => t.x === tile.x && t.y === tile.y - 1);
        if (down) beliefs.declare(`down ${id} ${tileId(down.x, down.y)}`);
    }

    // Pacchi
    for (const parcel of parcels) {
        const pid = `p${parcel.id}`;
        beliefs.declare(`parcel ${pid}`);
        beliefs.declare(`at ${pid} ${tileId(parcel.x, parcel.y)}`);
    }

    // Costruisci objects e init
    const objects = beliefs.objects.join(' ');
    const init    = beliefs.toPddlString();

    // Goal: pickup + deliver il pacco specificato
    const goalPddlId = `p${goalParcelId}`;
    const goal = `(delivered ${goalPddlId})`;

    return new PddlProblem('deliveroo-problem', objects, init, goal);
}


// ─────────────────────────────────────────────
// 3. SOLVER: chiama il solver online e restituisce il piano
// ─────────────────────────────────────────────

/**
 * Calcola un piano PDDL per raccogliere e consegnare un pacco.
 * 
 * @param {{ x: number, y: number, id: string }} me
 * @param {Array<{ x: number, y: number, type: string }>} mapTiles
 * @param {Array<{ id: string, x: number, y: number }>} parcels
 * @param {string} goalParcelId - id del pacco da raccogliere e consegnare
 * @returns {Promise<Array<{ action: string, args: string[] }> | null>}
 *   - Array di passi, es: [{ action: 'move_right', args: ['agent1','t0_0','t1_0'] }, ...]
 *   - null se nessun piano trovato
 */
export async function getPddlPlan(me, mapTiles, parcels, goalParcelId) {

    const domain  = buildDeliverooDomain();
    const problem = buildDeliverooProblem(me, mapTiles, parcels, goalParcelId);

    console.log('[PDDL] Invio problema al solver online...');

    let rawPlan;
    try {
        rawPlan = await onlineSolver(domain.toPddlString(), problem.toPddlString());
    } catch (err) {
        console.error('[PDDL] Errore dal solver:', err.message);
        return null;
    }

    if (!rawPlan || rawPlan.length === 0) {
        console.warn('[PDDL] Nessun piano trovato per il pacco', goalParcelId);
        return null;
    }

    console.log('[PDDL] Piano trovato:', rawPlan.length, 'passi');

    // rawPlan è un array tipo: [{ action: 'move_right', args: ['agent1','t0_0','t1_0'] }, ...]
    return rawPlan;
}


/**
 * Converte un piano PDDL in una sequenza di mosse semplici da eseguire.
 * 
 * @param {Array<{ action: string }>} plan
 * @returns {string[]} Array di direzioni: 'right' | 'left' | 'up' | 'down' | 'pickup' | 'putdown'
 */
export function planToMoves(plan) {
    const moveMap = {
        'move_right': 'right',
        'move_left':  'left',
        'move_up':    'up',
        'move_down':  'down',
        'pickup':     'pickup',
        'putdown':    'putdown',
    };

    return plan.map(step => moveMap[step.action] ?? step.action);
}


// ─────────────────────────────────────────────
// 4. ESEMPIO DI USO (decommentare per testare standalone)
// ─────────────────────────────────────────────

/*
// Test rapido: mappa 3x3, agente in (0,0), pacco in (2,0), delivery in (2,2)
const ME = { id: 'agent1', x: 0, y: 0 };

const MAP = [
    { x: 0, y: 0, type: '1' }, { x: 1, y: 0, type: '1' }, { x: 2, y: 0, type: '1' },
    { x: 0, y: 1, type: '1' }, { x: 1, y: 1, type: '1' }, { x: 2, y: 1, type: '1' },
    { x: 0, y: 2, type: '1' }, { x: 1, y: 2, type: '1' }, { x: 2, y: 2, type: '2' }, // delivery
];

const PARCELS = [{ id: 'abc123', x: 2, y: 0 }];

const plan = await getPddlPlan(ME, MAP, PARCELS, 'abc123');
if (plan) {
    const moves = planToMoves(plan);
    console.log('Mosse:', moves);
    // ['right', 'right', 'pickup', 'up', 'up', 'putdown']
}
*/