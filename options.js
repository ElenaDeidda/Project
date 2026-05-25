// options.js — Generazione opzioni e deliberazione
import { beliefs, getAgentPositions, getBlockedCells } from './beliefs.js';
import { smartDist, scoreParcel, nearestDeliveryDist }  from './basic_functions.js';

const VISIBILITY_BONUS = 2;
// ─── Raccolta multi-pacco adattiva ─────────────────────────────────────────
const BASE_N            = 3;      // raccoglie finché valore portato ≥ N × avg_reward
const N_MIN             = 1;      // soglia minima: consegna sempre a 1× avg_reward
const N_REDUCE_STEP     = 0.5;    // di quanto si riduce N a ogni trigger
const NO_PARCEL_TIMEOUT = 6000;   // ms senza pacchi a terra visibili → riduci N
const DECAY_THRESHOLD   = 0.75;   // se valore scende a <75% del picco → riduci N

let N_current      = BASE_N;
let sessionPeak    = 0;           // valore massimo portato in questa sessione
let lastGroundTime = null;        // ultima volta con ≥1 pacco a terra visibile
let deliverLatch   = false;       // una volta scattata la soglia, resta in consegna

function resetCollection() {
    N_current      = BASE_N;
    sessionPeak    = 0;
    lastGroundTime = null;
    deliverLatch   = false;
}

function carriedValue() {
    return beliefs.carriedParcels.reduce((s, p) => s + (p.reward ?? 0), 0);
}

function shouldDeliver() {
    if (!isCarrying()) { resetCollection(); return false; }
    if (deliverLatch)  return true;

    if (lastGroundTime === null) lastGroundTime = Date.now();

    const avgReward = beliefs.config.GAME?.parcels?.reward_avg ?? 10;
    const capacity  = beliefs.config.GAME?.player?.capacity    ?? Infinity;
    const value     = carriedValue();

    if (value > sessionPeak) sessionPeak = value;

    const hasGround = [...beliefs.parcels.values()].some(p => !p.carriedBy);
    if (hasGround) lastGroundTime = Date.now();

    // 1. Capacità piena → consegna subito
    if (beliefs.carriedParcels.length >= capacity) {
        console.log(`[OPTIONS] Capacità piena → consegna`);
        return (deliverLatch = true);
    }

    const now = Date.now();

    // 2. Nessun pacco visibile da troppo → riduci N
    if (now - lastGroundTime > NO_PARCEL_TIMEOUT && N_current > N_MIN) {
        N_current = Math.max(N_MIN, N_current - N_REDUCE_STEP);
        lastGroundTime = now;
        console.log(`[OPTIONS] Nessun pacco da ${NO_PARCEL_TIMEOUT}ms → N = ${N_current.toFixed(1)}`);
    }

    // 3. Valore decaduto troppo → riduci N
    if (sessionPeak > 0 && value < sessionPeak * DECAY_THRESHOLD && N_current > N_MIN) {
        N_current = Math.max(N_MIN, N_current - N_REDUCE_STEP);
        sessionPeak = value;
        console.log(`[OPTIONS] Decay valore → N = ${N_current.toFixed(1)}`);
    }

    // 4. Soglia raggiunta
    if (value >= N_current * avgReward) {
        console.log(`[OPTIONS] Soglia: ${value.toFixed(0)} ≥ ${(N_current * avgReward).toFixed(0)} → consegna`);
        return (deliverLatch = true);
    }

    return false;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function isCarrying() {
    return beliefs.carrying || beliefs.carriedParcels.length > 0;
}


// ─── sezioni di generateOptions ───────────────────────────────────────────────

function buildPickupOptions(agentPositions) {
    const options = [];
    const blocked = getBlockedCells();

    for (const [id, parcel] of beliefs.parcels.entries()) {
        // Già portato da qualcuno
        if (parcel.carriedBy) continue;

        // Tile occupata da un agente avversario: non riusciremmo a raccoglierlo
        const key = `${Math.round(parcel.x)}_${Math.round(parcel.y)}`;
        if (blocked.has(key)) continue;

        const delDist = nearestDeliveryDist(parcel, beliefs.deliveryPoints);
        const score   = scoreParcel(beliefs.me, parcel, agentPositions, delDist);

        // Scarta subito pacchi con score negativo infinito (irraggiungibili o reward 0)
        if (score === -Infinity) continue;

        options.push(['go_pick_up', parcel.x, parcel.y, id, score]);
    }

    return options;
}

function buildDeliverOptions() {
    // Nessun pacco da consegnare → nessuna opzione
    if (beliefs.deliveryPoints.length === 0) return [];

    return beliefs.deliveryPoints.map(dp => [
        'deliver',
        dp.x,
        dp.y,
        smartDist(beliefs.me, dp),
    ]);
}

function buildSpawnOptions() {
    const blocked = getBlockedCells();
    const options = [];


    for (const [key, tile] of beliefs.mapTiles.entries()) {
        if (tile.type !== '1') continue;

        // Tile occupata da un agente avversario
        if (blocked.has(key)) continue;

        const [x, y] = key.split('_').map(Number);

        // Esclude la tile andata in timeout

        const myDist     = smartDist(beliefs.me, { x, y });
        const delDist    = nearestDeliveryDist({ x, y }, beliefs.deliveryPoints);
        const visibility = beliefs.spawnVisibility.get(key) ?? 0;

        // Score: premia tile vicine, vicine a un delivery e con alta visibilità spawn
        const score = -(myDist + delDist) + visibility * VISIBILITY_BONUS;

        options.push(['go_to_spawn', x, y, score]);
    }
    return options;
}

// ─── API pubblica ──────────────────────────────────────────────────────────────

/**
 * Genera le opzioni disponibili in base ai beliefs correnti.
 *
 * Casi mutualmente esclusivi:
 *   - Se stai portando pacchi  → solo opzioni 'deliver'
 *   - Altrimenti               → opzioni 'go_pick_up' + 'go_to_spawn'
 */
export function generateOptions() {
    if (shouldDeliver()) {
        return buildDeliverOptions();
    }

    // Non sta portando nulla, OPPURE sta portando ma non ha ancora raggiunto
    // la soglia → continua a cercare pacchi da raccogliere

    const agentPositions = getAgentPositions();
    return [
        ...buildPickupOptions(agentPositions),
        ...buildSpawnOptions(),
    ];
}

/**
 * Sceglie la migliore opzione dall'insieme generato da generateOptions().
 *
 * Priorità:
 *   1. deliver  → delivery point con distanza Manhattan minima
 *   2. go_pick_up → pacco con score massimo (se ≥ SCORE_MIN)
 *   3. go_to_spawn → spawn tile con score massimo
 *   4. fallback → ['go_to_spawn'] senza coordinate
 */
// ─── Commitment / isteresi ──────────────────────────────────────────────────
// Per evitare che l'agente cambi target a ogni tick quando due opzioni hanno
// score quasi uguale, ricordiamo l'opzione attualmente perseguita e cambiamo
// solo se un'alternativa la supera di almeno STICKY_MARGIN (in valore relativo).
const STICKY_MARGIN = 0.20;   // 20%
let committedKey = null;

function _optionKey(o) {
    if (o[0] === 'go_pick_up')  return `${o[0]}_${o[1]}_${o[2]}_${o[3]}`;
    if (o[0] === 'deliver')     return `${o[0]}_${o[1]}_${o[2]}`;
    if (o[0] === 'go_to_spawn') return o[1] != null ? `${o[0]}_${o[1]}_${o[2]}` : o[0];
    return o[0];
}

function _commit(option) {
    committedKey = _optionKey(option);
    return option;
}

// Decide se mantenere il target corrente `cur` invece di passare a `best`.
// higherIsBetter=true  → score (pickup/spawn): cambia se best supera cur del margine
// higherIsBetter=false → distanza (deliver):  cambia se best è più vicino del margine
function _shouldSwitch(best, cur, score, higherIsBetter) {
    const delta = higherIsBetter ? score(best) - score(cur)
                                 : score(cur)  - score(best);
    return delta > STICKY_MARGIN * Math.abs(score(cur));
}

export function deliberate(options) {
    const SCORE_MIN = -100;

    if (isCarrying()) {
        const delivers = options.filter(o => o[0] === 'deliver');
        if (delivers.length > 0) {
            const best = delivers.reduce((b, c) => c[3] < b[3] ? c : b);
            const cur  = delivers.find(o => _optionKey(o) === committedKey);
            if (cur && _optionKey(best) !== committedKey &&
                !_shouldSwitch(best, cur, o => o[3], false))
                return cur;                     // resta sulla delivery corrente
            return _commit(best);
        }
    }

    const pickups = options.filter(o => o[0] === 'go_pick_up');
    if (pickups.length > 0) {
        const best = pickups.reduce((b, c) => c[4] > b[4] ? c : b);
        if (best[4] >= SCORE_MIN) {
            const cur = pickups.find(o => _optionKey(o) === committedKey);
            if (cur && _optionKey(best) !== committedKey &&
                !_shouldSwitch(best, cur, o => o[4], true))
                return cur;                     // resta sul pacco corrente
            return _commit(best);
        }
    }

    const spawns = options.filter(o => o[0] === 'go_to_spawn');
    if (spawns.length > 0) {
        spawns.sort((a, b) => b[3] - a[3]);
        const best = spawns[0];
        const top2 = spawns.slice(0, 2).map(o => `(${o[1]},${o[2]})=${o[3].toFixed(1)}`).join(' | ');
        console.log(`[DELIBERATE] spawn top2: ${top2}`);
        const cur = spawns.find(o => _optionKey(o) === committedKey);
        if (cur && _optionKey(best) !== committedKey &&
            !_shouldSwitch(best, cur, o => o[3], true))
            return cur;                         // resta sulla spawn tile corrente
        return _commit(best);
    }

    return _commit(['go_to_spawn']);
}