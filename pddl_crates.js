// pddl_creates.js
// Planner PDDL per mappe con casse (tile tipo '5!').
//
// Struttura ispirata al pattern lab5 (4domain.js):
//   1. buildDomain()        → stringa PDDL fissa del dominio
//   2. buildProblem()       → stringa PDDL generata dai beliefs correnti
//      (pre-processing: omette le crate-slot morte (dead square), vedi sezione 0)
//   3. callSolver()         → chiama onlineSolver con timeout
//   4. buildExecutionPlan() → traduce ogni azione del piano (move/push) in
//                             un passo eseguibile con emitMove
//   5. execCratePlan()      → executor: chiama subito il PDDL ed esegue il
//                             piano passo-passo con emitMove (move e push
//                             allo stesso modo). A* è SOLO il fallback di
//                             emergenza usato quando il solver non trova
//                             alcun piano — mai durante l'esecuzione di un
//                             piano già trovato.
//
// Export pubblici: execCratePlan() (usato da plans_crate.js) e
// computeDeadSquares() (usato da beliefs.js per precalcolare beliefs.deadSquares
// una sola volta al caricamento mappa).
// Import dalla libreria: solo onlineSolver

import { onlineSolver } from '@unitn-asa/pddl-client';
import { navigateTo, opportunisticActions } from './moves.js';

const PDDL_TIMEOUT_MS     = 20000;  // rete di sicurezza generosa, non una scadenza "normale"
const ASTAR_RETRY         = 3;      // tentativi A* (solo fallback di emergenza, vedi execCratePlan)
const TIMEOUT_COOLDOWN_MS = 15000;  // pausa breve su un target dopo un timeout, prima di riprovarlo
const MAX_CONSECUTIVE_FAILURES = 3; // dopo N timeout consecutivi sullo stesso target → escluso per sempre

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
// 0. PRE-PROCESSING DEADLOCK — riduce lo spazio di ricerca del solver
//    omettendo dal problem le crate-slot in cui spingere una cassa sarebbe
//    un deadlock permanente. Nessuna modifica al dominio: si riusa la
//    precondizione (crate-slot ?behind) già esistente sulle push — se il
//    fatto non viene dichiarato, tutte le push verso quella tile diventano
//    semplicemente irrealizzabili.
// ─────────────────────────────────────────────────────────────────────────────

const DIRECTIONS = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];

function isWall(mapTiles, x, y) {
    const t = mapTiles.get(`${x}_${y}`);
    return !t || t.type === '0';
}

/**
 * Calcolo STATICO (solo geometria: muri + crate-slot, indipendente da dove
 * sono casse/agente in questo istante) → da chiamare una sola volta al
 * caricamento mappa (vedi beliefs.js::updateMap), non ad ogni chiamata al
 * solver.
 *
 * Una crate-slot è "morta" se NON esiste alcuna direzione di push-fuori
 * strutturalmente possibile (l'agente può stare sul lato opposto E la
 * destinazione è anch'essa una crate-slot): in tal caso, una cassa spinta
 * lì non potrà mai più essere mossa, qualunque target si stia cercando di
 * raggiungere. Basta una via d'uscita singola per non essere "morta" — non
 * serve che anche la tile di destinazione abbia a sua volta una via d'uscita:
 * quella è una proprietà della destinazione, non di questa tile.
 */
export function computeDeadSquares(mapTiles) {
    const slots = [];
    for (const [key, tile] of mapTiles.entries()) {
        if (tile.type === '5' || tile.type === '5!') slots.push(key);
    }

    // Un solo passaggio: una crate-slot è morta solo se NON esiste alcuna
    // direzione strutturalmente possibile per spingere via una cassa che vi
    // si trovasse (muro dietro l'agente, o destinazione non è una slot).
    // Non richiediamo che la destinazione sia a sua volta "viva all'infinito":
    // basta una via d'uscita singola per liberare il percorso ora — la sua
    // eventuale futura immobilità è un problema della destinazione, non di
    // questa tile.
    const slotSet = new Set(slots);
    const dead = new Set();

    for (const key of slots) {
        const [x, y] = key.split('_').map(Number);
        const hasEscape = DIRECTIONS.some(({ dx, dy }) => {
            const behindOk = !isWall(mapTiles, x - dx, y - dy);   // tile dove sta l'agente
            const destKey  = `${x + dx}_${y + dy}`;
            return behindOk && slotSet.has(destKey);
        });
        if (!hasEscape) dead.add(key);
    }

    return dead;
}

// computeFreezeDeadlock: DISATTIVATA. Calcolo dinamico (dipendente dalla
// configurazione attuale delle altre casse) che doveva rilevare casse
// "frozen" (bloccate sia in orizzontale che in verticale da muri o altre
// casse a loro volta frozen) per escluderle come crate-slot dal problem.
// Anche dopo aver corretto il guard sui cicli (risolto come "non frozen"
// invece di "frozen"), su mappe dense con molte casse adiacenti continuava
// a sovra-escludere slot, rendendo IRRISOLVIBILE per il solver remoto un
// target in realtà raggiungibile (osservato in game: DeliverCrate → (5,2),
// timeout 20000ms + retry bloccato sullo stesso job esterno). Si è scelto
// di non usarla più: resta solo l'esclusione statica computeDeadSquares
// (sicura, nessun falso positivo dinamico possibile).
//
// export function computeFreezeDeadlock(cratePos, mapTiles, crateTiles, visited = new Set()) {
//     const key = `${cratePos.x}_${cratePos.y}`;
//     if (visited.has(key)) return false;  // ciclo di casse → non assumere "bloccata": sovra-esclusione è peggio
//     visited.add(key);
//
//     const isWallOrFrozenCrate = (x, y) => {
//         if (isWall(mapTiles, x, y)) return true;
//         const k = `${x}_${y}`;
//         if (crateTiles.has(k)) return computeFreezeDeadlock({ x, y }, mapTiles, crateTiles, visited);
//         return false;
//     };
//
//     const blockedH = isWallOrFrozenCrate(cratePos.x + 1, cratePos.y) && isWallOrFrozenCrate(cratePos.x - 1, cratePos.y);
//     const blockedV = isWallOrFrozenCrate(cratePos.x, cratePos.y + 1) && isWallOrFrozenCrate(cratePos.x, cratePos.y - 1);
//     return blockedH && blockedV;
// }


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

    /** Slot cassa: tile valide come destinazione di push ('5' e '5!'),
     *  escluse le dead square statiche — riduce lo spazio di ricerca del
     *  solver senza toccare il dominio (vedi sezione 0).
     *  L'esclusione dinamica via computeFreezeDeadlock è disattivata: anche
     *  dopo la correzione del guard sui cicli, su mappe dense con molte
     *  casse adiacenti continuava a sovra-escludere slot, rendendo
     *  irrisolvibile per il solver remoto un target in realtà raggiungibile
     *  (vedi DeliverCrate → (5,2): timeout 20000ms + retry bloccato sullo
     *  stesso job esterno). Resta solo deadSquares (statico, sicuro). */
    let excludedSlots = 0;
    for (const [key, tile] of beliefs.mapTiles.entries()) {
        if (tile.type !== '5' && tile.type !== '5!') continue;
        const [x, y] = key.split('_').map(Number);
        const tid = tileId(x, y);
        objects.add(tid);

        if (beliefs.deadSquares?.has(key)) { excludedSlots++; continue; }
        // if (!beliefs.crateTiles.has(key) &&
        //     computeFreezeDeadlock({ x, y }, beliefs.mapTiles, beliefs.crateTiles)) {
        //     excludedSlots++; continue;
        // }

        facts.push(`(crate-slot ${tid})`);
    }
    if (excludedSlots > 0) {
        console.log(`[PDDL_CREATES] ${excludedSlots} crate-slot escluse dal problem (dead square)`);
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
    // La cache deve includere la posizione di partenza dell'agente: un piano
    // calcolato da (ax,ay) non è valido se richiamato di nuovo da una
    // posizione diversa (es. dopo che una move è stata rifiutata e l'agente
    // non si è mosso da dove si trovava prima del piano stale precedente).
    // Senza questo, un piano "vecchio" può essere riservito all'infinito.
    const ax = Math.round(beliefs.me.x), ay = Math.round(beliefs.me.y);
    const cacheKey = `${ax}_${ay}→${Math.round(targetX)}_${Math.round(targetY)}|${crateStateHash(beliefs)}`;
    if (planCache.has(cacheKey)) {
        console.log(`[PDDL_CREATES] piano da cache per (${targetX},${targetY}) — solver non chiamato`);
        return planCache.get(cacheKey);
    }

    const domain  = buildDomain();
    const problem = buildProblem(beliefs, targetX, targetY);

    console.log(`[PDDL_CREATES] Casse nei beliefs (${beliefs.crateTiles.size}):`,
        [...beliefs.crateTiles.keys()].join(', ') || 'nessuna');

    let rawPlan;
    try {
        rawPlan = await Promise.race([
            onlineSolver(domain, problem),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`timeout ${PDDL_TIMEOUT_MS}ms`)), PDDL_TIMEOUT_MS)
            ),
        ]);
    } catch (err) {
        // Timeout o errore del client PDDL (HTTP, parsing, ecc.): stesso
        // contratto del "nessun piano trovato" qui sotto, mai un'eccezione
        // che risale ai chiamanti — altrimenti il target non verrebbe mai
        // marcato e verrebbe riprovato all'infinito (visto in game: stesso
        // target in timeout ad ogni ciclo, agente bloccato col pacco in mano).
        return _handleSolverFailure(beliefs, targetX, targetY, err.message);
    }

    // rawPlan === [] è un piano valido (goal già soddisfatto, es. siamo già
    // sul target): solo rawPlan falsy (undefined/null) è un vero fallimento
    // del solver. Trattare [] come fallimento blacklistava per sempre target
    // a cui l'agente era già arrivato.
    if (!rawPlan) {
        return _handleSolverFailure(beliefs, targetX, targetY, 'nessun piano trovato');
    }

    console.log(`[PDDL_CREATES] Piano trovato: ${rawPlan.length} passi`);
    planCache.set(cacheKey, rawPlan);
    beliefs.crateTargetFailures?.delete(`${Math.round(targetX)}_${Math.round(targetY)}`);
    return rawPlan;
}

// Un fallimento del solver (timeout o nessun piano) non esclude subito per
// sempre il target: un singolo timeout può essere solo lentezza transitoria
// del solver esterno condiviso. Il target va in cooldown breve e si riprova;
// solo dopo MAX_CONSECUTIVE_FAILURES fallimenti consecutivi diventa
// permanentemente unreachable (fino al prossimo spostamento di una cassa,
// che già azzera unreachableCrateTargets in beliefs.js).
function _handleSolverFailure(beliefs, targetX, targetY, reason) {
    const key   = `${Math.round(targetX)}_${Math.round(targetY)}`;
    const count = (beliefs.crateTargetFailures.get(key) ?? 0) + 1;

    if (count >= MAX_CONSECUTIVE_FAILURES) {
        beliefs.crateTargetFailures.delete(key);
        beliefs.crateTargetCooldowns.delete(key);
        beliefs.unreachableCrateTargets.add(key);
        console.error(`[PDDL_CREATES] NESSUN PIANO TROVATO verso (${targetX},${targetY}) dopo ${count} tentativi (${reason}) — target escluso permanentemente`);
    } else {
        beliefs.crateTargetFailures.set(key, count);
        beliefs.crateTargetCooldowns.set(key, Date.now() + TIMEOUT_COOLDOWN_MS);
        console.warn(`[PDDL_CREATES] Solver fallito verso (${targetX},${targetY}) — ${reason} (tentativo ${count}/${MAX_CONSECUTIVE_FAILURES}, cooldown ${TIMEOUT_COOLDOWN_MS}ms)`);
    }
    return null;
}



// ─────────────────────────────────────────────────────────────────────────────
// 5. PIANO → SEQUENZA MOSSE (come PddlExecutor di lab5, ma per il nostro dominio)
//
//    Ogni azione del piano PDDL diventa UN passo eseguito direttamente con
//    emitMove, nello stesso ordine deciso dal solver — niente A*: il piano
//    è già un percorso passo-passo valido, ricalcolarlo con A* sarebbe solo
//    un giro a vuoto (e potrebbe deviare dal piano se nel frattempo un'altra
//    cella risulta più "comoda" per l'euristica di A*, pur essendo ancora
//    valido sulla mappa). A* resta riservato al SOLO fallback di emergenza
//    in execCratePlan(), quando il solver non trova proprio nessun piano.
//
//    Struttura del risultato:
//    [
//      { type: 'move', direction },
//      { type: 'push', direction, crateFrom, crateTo },
//    ]
// ─────────────────────────────────────────────────────────────────────────────

const PUSH_ACTIONS = new Set(['push-right', 'push-left', 'push-up', 'push-down']);

function buildExecutionPlan(planSteps) {
    const sequence = [];

    for (const step of planSteps) {
        const act = step.action.toLowerCase();

        if (act === 'move') {
            const from = parseCoords(step.args[1]);
            const to   = parseCoords(step.args[2]);
            if (!from || !to) continue;

            const direction = directionBetween(from, to);
            if (direction) sequence.push({ type: 'move', direction });
        }

        if (PUSH_ACTIONS.has(act)) {
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

    return sequence;
}


// ─────────────────────────────────────────────────────────────────────────────
// 6. EXECUTOR — esegue il piano (pattern PddlExecutor di lab5)
//
//    Per ogni passo, 'move' e 'push' fanno entrambi emitMove diretto (il
//    push aggiorna anche i beliefs delle casse). Se un emitMove viene
//    rifiutato (stato del mondo cambiato — un altro agente si è messo in
//    mezzo, una cassa si è spostata, ecc.) si ricalcola tutto il piano dalla
//    posizione corrente, NON si passa ad A*: A* non sa spingere le casse e
//    qui il piano PDDL è la fonte di verità.
//
//    Dopo ogni passo riuscito si chiama opportunisticActions(): se l'agente
//    si ritrova sopra un pacco lo raccoglie, se è su una delivery tile con
//    pacchi in mano li consegna — stessa logica già usata da navigateTo()
//    sui percorsi A*, ora attiva anche durante l'esecuzione diretta del
//    piano PDDL (prima veniva persa perché qui non si passava più da A*).
//
//    Ritorna true se arrivati a destinazione, false altrimenti.
// ─────────────────────────────────────────────────────────────────────────────

export async function execCratePlan(beliefs, socket, targetX, targetY, shouldStop = () => false) {

    // Il PDDL è la fonte primaria su mappe con casse: A* non sa spingere,
    // quindi tentarlo prima sprecherebbe mosse/tempo (reward che decadono)
    // ogni volta che il percorso diretto è bloccato da una cassa. Il PDDL
    // viene chiamato subito; A* resta solo come fallback di emergenza se
    // il solver non trova alcun piano (vedi sotto).
    let rawPlan = null;
    try {
        rawPlan = await callSolver(beliefs, targetX, targetY);
    } catch (err) {
        console.warn('[PDDL_CREATES] Solver fallito:', err.message);
    }

    if (!rawPlan) {
        console.warn('[CRATE] PDDL fallito — fallback A* di emergenza');
        const fallback = await navigateTo(
            beliefs.me, { x: targetX, y: targetY }, socket, beliefs.mapTiles, shouldStop, ASTAR_RETRY,
        );
        if (fallback === 'reached') return true;
        return false;
    }

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
                try {
                    rawPlan = await callSolver(beliefs, targetX, targetY);
                } catch (err) {
                    console.warn('[PDDL_CREATES] Ricalcolo solver fallito (push):', err.message);
                    return false;
                }
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

            await opportunisticActions(beliefs.me, socket);

            stepIndex++;
            continue;
        }

        // ── MOVE (passo puro del piano, nessuna cassa coinvolta) ─────────────
        if (step.type === 'move') {
            const result = await socket.emitMove(step.direction);

            if (result?.x == null) {
                console.warn(`[PDDL_CREATES] Move '${step.direction}' rifiutato — ricalcolo piano`);
                // Mossa rifiutata: stato del mondo cambiato → ricalcola tutto
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

            beliefs.me.x = result.x;
            beliefs.me.y = result.y;

            await opportunisticActions(beliefs.me, socket);

            stepIndex++;
            continue;
        }
    }

    // Verifica arrivo
    const arrived = Math.round(beliefs.me.x) === Math.round(targetX) &&
                    Math.round(beliefs.me.y) === Math.round(targetY);

    console.log(`[PDDL_CREATES] ${arrived ? '✅ Arrivato' : '⚠️  Non arrivato'} a (${targetX},${targetY})`);
    return arrived;
}