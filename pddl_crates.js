// pddl_creates.js
// Planner PDDL per mappe con casse (tile tipo '5!').
//
// Struttura ispirata al pattern lab5 (4domain.js):
//   1. buildDomain()        → stringa PDDL fissa del dominio
//   2. buildProblem()       → stringa PDDL generata dai beliefs correnti
//   3. callSolver()         → chiama onlineSolver con timeout
//   4. buildExecutionPlan() → separa push da segmenti move puri (→ A*)
//   5. execCratePlan()      → executor: push con emitMove, move con A*;
//                             se A* fallisce → ricalcola con il solver
//
// Unico export pubblico: execCratePlan() — usato da plans_crate.js
// Import dalla libreria: solo onlineSolver

import { onlineSolver } from '@unitn-asa/pddl-client';
import { navigateTo }                  from './moves.js';

const PDDL_TIMEOUT_MS = 5000;
const ASTAR_RETRY     = 3;      // tentativi A* prima di tornare al solver

// Cache piani: chiave = target + stato attuale delle casse. Evita di
// richiamare il solver remoto per la stessa identica configurazione.
const planCache = new Map();   // "tx_ty|crateState" → rawPlan

function crateStateHash(beliefs) {
    return [...beliefs.crateTiles.keys()].sort().join(',');
}


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
// 2. DOMAIN — stringa PDDL fissa (ispirata a domain-deliveroojs-crates.pddl)
//    Separata come funzione per chiarezza, esattamente come in lab5.
// ─────────────────────────────────────────────────────────────────────────────

function buildDomain() {
    return `(define (domain crate-world)
  (:requirements :strips :negative-preconditions)
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
// 3. PROBLEM — costruito dai beliefs correnti (pattern Beliefset di lab5)
//
//    Non usiamo la classe Beliefset della libreria perché:
//    - genera oggetti duplicati
//    - non supporta predicati direzionali (right/left/up/down)
//    Usiamo invece Set + Array manuale, che è concettualmente identico.
// ─────────────────────────────────────────────────────────────────────────────

function buildProblem(beliefs, targetX, targetY) {
    const agentKey = `${Math.round(beliefs.me.x)}_${Math.round(beliefs.me.y)}`;
    const objects  = new Set(['agent1']);
    const facts    = [];

    /** Agente */
    const agentTile = tileId(beliefs.me.x, beliefs.me.y);
    objects.add(agentTile);
    facts.push(`(me agent1)`);
    facts.push(`(at agent1 ${agentTile})`);

    /** Casse — escludi la posizione dell'agente (stato iniziale contraddittorio) */
    for (const [key, pos] of beliefs.crateTiles.entries()) {
        if (key === agentKey) continue;
        const tid = tileId(pos.x, pos.y);
        objects.add(tid);
        facts.push(`(crate-at ${tid})`);
    }

    /** Adiacenze: connected (per MOVE) + direzionali right/left/up/down (per PUSH) */
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

    /** Slot cassa: tile valide come destinazione di push ('5' e '5!') */
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
// 4. SOLVER — chiama onlineSolver con timeout (pattern lab5)
// ─────────────────────────────────────────────────────────────────────────────

async function callSolver(beliefs, targetX, targetY) {
    const cacheKey = `${Math.round(targetX)}_${Math.round(targetY)}|${crateStateHash(beliefs)}`;
    if (planCache.has(cacheKey)) {
        console.log(`[PDDL_CREATES] piano da cache per (${targetX},${targetY}) — solver non chiamato`);
        return planCache.get(cacheKey);
    }

    const domain  = buildDomain();
    const problem = buildProblem(beliefs, targetX, targetY);

    console.log(`[PDDL_CREATES] Casse nei beliefs (${beliefs.crateTiles.size}):`,
        [...beliefs.crateTiles.keys()].join(', ') || 'nessuna');

    const rawPlan = await Promise.race([
        onlineSolver(domain, problem),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`timeout ${PDDL_TIMEOUT_MS}ms`)), PDDL_TIMEOUT_MS)
        ),
    ]);

    if (!rawPlan || rawPlan.length === 0) {
        console.error(`[PDDL_CREATES] NESSUN PIANO TROVATO verso (${targetX},${targetY}) — target escluso permanentemente`);
        beliefs.unreachableCrateTargets.add(`${Math.round(targetX)}_${Math.round(targetY)}`);
        return null;
    }

    console.log(`[PDDL_CREATES] Piano trovato: ${rawPlan.length} passi`);
    planCache.set(cacheKey, rawPlan);
    return rawPlan;
}



// ─────────────────────────────────────────────────────────────────────────────
// 5. PIANO → SEQUENZA MOSSE (come PddlExecutor di lab5, ma per il nostro dominio)
//
//    Separa le mosse in due categorie:
//    - PUSH: eseguite passo per passo con emitMove (aggiornano beliefs casse)
//    - MOVE pura: raggruppate in segmenti consecutivi → affidate ad A*
//
//    Struttura del risultato:
//    [
//      { type: 'push', direction, crateFrom, crateTo },
//      { type: 'move', direction },   ← solo se A* non disponibile
//      { type: 'astar', target },     ← segmento move puro → A*
//    ]
// ─────────────────────────────────────────────────────────────────────────────

const PUSH_ACTIONS = new Set(['push-right', 'push-left', 'push-up', 'push-down']);

function buildExecutionPlan(planSteps) {
    const sequence = [];
    let moveBatch  = [];   // accumula mosse MOVE consecutive

    const flushMoveBatch = () => {
        if (moveBatch.length === 0) return;
        // L'ultimo nodo del batch è il target A*
        const target = moveBatch[moveBatch.length - 1];
        sequence.push({ type: 'astar', target });
        moveBatch = [];
    };

    for (const step of planSteps) {
        const act = step.action.toLowerCase();

        if (act === 'move') {
            const to = parseCoords(step.args[2]);
            if (to) moveBatch.push(to);
        }

        if (PUSH_ACTIONS.has(act)) {
            // Prima di ogni push: consegna il batch move accumulato ad A*
            flushMoveBatch();

            const from    = parseCoords(step.args[1]);
            const crateAt = parseCoords(step.args[2]);
            const behind  = parseCoords(step.args[3]);
            if (!from || !crateAt || !behind) continue;

            const direction = directionBetween(from, crateAt);
            if (direction) {
                sequence.push({
                    type:      'push',
                    direction,
                    crateFrom: crateAt,
                    crateTo:   behind,
                });
            }
        }
    }

    // Flush finale: mosse MOVE in coda al piano
    flushMoveBatch();
    return sequence;
}


// ─────────────────────────────────────────────────────────────────────────────
// 6. EXECUTOR — esegue il piano (pattern PddlExecutor di lab5)
//
//    Per ogni passo:
//    - 'push'  → emitMove diretto + aggiorna beliefs casse
//    - 'astar' → navigateTo (A*); se fallisce → ricalcola con solver
//
//    Ritorna true se arrivati a destinazione, false altrimenti.
// ─────────────────────────────────────────────────────────────────────────────

export async function execCratePlan(beliefs, socket, targetX, targetY, shouldStop = () => false) {

    // FIX: prova prima A* diretto — il solver PDDL serve solo se il percorso
    // è bloccato da una cassa (A* ora la riconosce come muro, vedi moves.js)
    const direct = await navigateTo(
        beliefs.me, { x: targetX, y: targetY }, socket, beliefs.mapTiles, shouldStop, ASTAR_RETRY,
    );
    if (direct === 'stopped') return false;
    if (direct === 'reached') {
        console.log(`[PDDL_CREATES] ✅ Arrivato a (${targetX},${targetY}) via A* diretto — PDDL non necessario`);
        return true;
    }
    console.log(`[PDDL_CREATES] A* diretto bloccato verso (${targetX},${targetY}) — richiedo piano PDDL`);

    /** Primo piano PDDL */
    let rawPlan = null;
    try {
        rawPlan = await callSolver(beliefs, targetX, targetY);
    } catch (err) {
        console.warn('[PDDL_CREATES] Solver fallito:', err.message);
        return false;
    }

    if (!rawPlan) return false;

    let executionPlan = buildExecutionPlan(rawPlan);
    let stepIndex     = 0;

    while (stepIndex < executionPlan.length) {
        if (shouldStop()) {
            console.log('[PDDL_CREATES] Esecuzione interrotta da shouldStop()');
            return false;
        }

        const step = executionPlan[stepIndex];

        // ── PUSH ────────────────────────────────────────────────────────────
        if (step.type === 'push') {
            console.log(`[PDDL_CREATES] PUSH ${step.direction} cassa (${step.crateFrom.x},${step.crateFrom.y}) → (${step.crateTo.x},${step.crateTo.y})`);

            const result = await socket.emitMove(step.direction);

            if (result?.x == null) {
                console.warn(`[PDDL_CREATES] Push '${step.direction}' rifiutato — ricalcolo piano`);
                // Push rifiutato: stato del mondo cambiato → ricalcola tutto
                rawPlan = await callSolver(beliefs, targetX, targetY);
                if (!rawPlan) return false;
                executionPlan = buildExecutionPlan(rawPlan);
                stepIndex = 0;
                continue;
            }

            // Aggiorna posizione agente
            beliefs.me.x = result.x;
            beliefs.me.y = result.y;

            // Aggiorna beliefs casse (ottimistico — riconciliato da updateCrates al prossimo sensing)
            const fromKey = `${step.crateFrom.x}_${step.crateFrom.y}`;
            const toKey   = `${step.crateTo.x}_${step.crateTo.y}`;
            beliefs.crateTiles.delete(fromKey);
            beliefs.crateTiles.set(toKey, step.crateTo);
            beliefs.mapTiles.set(fromKey, { type: '5'  });
            beliefs.mapTiles.set(toKey,   { type: '5!' });

            stepIndex++;
            continue;
        }

        // ── A* (segmento MOVE puro) ──────────────────────────────────────────
        if (step.type === 'astar') {
            console.log(`[PDDL_CREATES] A* verso (${step.target.x},${step.target.y})`);

            const outcome = await navigateTo(
                beliefs.me,
                step.target,
                socket,
                beliefs.mapTiles,
                shouldStop,
                ASTAR_RETRY,
            );

            if (outcome === 'reached') {
                stepIndex++;
                continue;
            }

            if (outcome === 'stopped') return false;

            // A* fallito (cassa spostata da altro agente o percorso bloccato)
            // → ricalcola il piano PDDL dalla posizione corrente
            console.warn(`[PDDL_CREATES] A* fallito verso (${step.target.x},${step.target.y}) — ricalcolo piano PDDL`);

            try {
                rawPlan = await callSolver(beliefs, targetX, targetY);
            } catch (err) {
                console.warn('[PDDL_CREATES] Ricalcolo solver fallito:', err.message);
                return false;
            }

            if (!rawPlan) return false;

            executionPlan = buildExecutionPlan(rawPlan);
            stepIndex = 0;
            continue;
        }
    }

    // Verifica arrivo
    const arrived = Math.round(beliefs.me.x) === Math.round(targetX) &&
                    Math.round(beliefs.me.y) === Math.round(targetY);

    console.log(`[PDDL_CREATES] ${arrived ? '✅ Arrivato' : '⚠️  Non arrivato'} a (${targetX},${targetY})`);
    return arrived;
}