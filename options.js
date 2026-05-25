// options.js — Generazione opzioni e deliberazione
import { beliefs, getAgentPositions, getBlockedCells } from './beliefs.js';
import { smartDist, scoreParcel, nearestDeliveryDist }  from './basic_functions.js';

const VISIBILITY_BONUS = 2;
// ─── Raccolta multi-pacco adattiva ─────────────────────────────────────────
// N = quanti "pacchi di valore medio" accumulare prima di consegnare
// (consegna quando valore_portato ≥ N × avg_reward).
//
// N viene inizializzato UNA SOLA VOLTA dalla config (decadimento + capacità)
// e poi NON viene mai resettato: si adatta in corso di partita.
const N_MIN             = 1;      // non si scende mai sotto 1× avg_reward
const N_REDUCE_STEP     = 0.5;    // quanto cala N su un trigger forzato
const N_INCREASE_STEP   = 0.5;    // quanto sale N dopo una consegna "pulita"
const NO_PICKUP_TIMEOUT = 6000;   // ms senza raccogliere nuovi pacchi → consegna
const DECAY_THRESHOLD   = 0.60;   // valore < 60% del picco del carico → consegna

// Stato persistente (MAI resettato durante la partita)
let N_current = null;             // null finché non inizializzato da config

// Stato per-carico (resettato a ogni consegna)
let batchPeak        = 0;         // picco di valore del carico attuale
let lastPickupTime   = null;      // ultimo pickup riuscito
let prevCarriedCount = 0;         // per rilevare nuovi pickup
let deliverLatch     = false;     // una volta deciso, resta in consegna
let deliverReason    = null;      // 'threshold' (pulita) | 'trigger' (forzata)

// Tetto per N: capacità reale se finita, altrimenti un default prudente
function capacityCap() {
    const c = beliefs.config.GAME?.player?.capacity;
    return Number.isFinite(c) ? c : 10;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Converte decaying_event ("1s", "500ms", "infinite", …) in ms per -1 reward
function parseDecayMs(decaying_event) {
    if (decaying_event == null || decaying_event === 'infinite') return Infinity;
    const m = String(decaying_event).match(/^(\d+(?:\.\d+)?)\s*(ms|s)?$/);
    if (!m) return Infinity;
    const val = parseFloat(m[1]);
    return (m[2] === 'ms') ? val : val * 1000;
}

// Valore iniziale di N derivato dalla dinamica di gioco:
//   quanti pacchi riesco a raccogliere prima che il primo perda
//   (1 - DECAY_THRESHOLD) del suo valore, limitato dalla capacità.
function computeInitialN() {
    const cfg       = beliefs.config.GAME ?? {};
    const avgReward = cfg.parcels?.reward_avg          ?? 10;
    const moveDur   = cfg.player?.movement_duration    ?? 500;
    const obsDist   = cfg.player?.observation_distance ?? 5;
    const decayMs   = parseDecayMs(cfg.parcels?.decaying_event);
    const cap       = capacityCap();

    // Nessun decadimento → conviene riempirsi fino alla capacità
    if (!Number.isFinite(decayMs)) return clamp(cap, N_MIN, cap);

    const lossFraction  = 1 - DECAY_THRESHOLD;              // 0.40
    const timeBudget    = lossFraction * avgReward * decayMs; // ms prima della soglia di decay
    const timePerPickup = Math.max(1, obsDist) * moveDur;     // ms stimati per un pickup
    const collectable   = Math.floor(timeBudget / timePerPickup);

    return clamp(collectable, N_MIN, cap);
}

function resetCollection() {
    // Consegna "pulita" (soglia/capacità) → su questa mappa conviene accumulare
    // un po' di più: alza N (adattamento bidirezionale).
    if (deliverReason === 'threshold' && N_current !== null) {
        N_current = clamp(N_current + N_INCREASE_STEP, N_MIN, capacityCap());
        console.log(`[OPTIONS] Consegna pulita → N = ${N_current.toFixed(1)}`);
    }
    batchPeak        = 0;
    lastPickupTime   = null;
    prevCarriedCount = 0;
    deliverLatch     = false;
    deliverReason    = null;
    // N_current NON viene toccato
}

function carriedValue() {
    return beliefs.carriedParcels.reduce((s, p) => s + (p.reward ?? 0), 0);
}

function shouldDeliver() {
    if (!isCarrying()) { resetCollection(); return false; }

    // Inizializzazione una-tantum di N dalla config
    if (N_current === null) {
        N_current = computeInitialN();
        console.log(`[OPTIONS] N iniziale = ${N_current.toFixed(1)}`);
    }

    if (deliverLatch) return true;

    const now       = Date.now();
    const avgReward = beliefs.config.GAME?.parcels?.reward_avg ?? 10;
    const capacity  = beliefs.config.GAME?.player?.capacity    ?? Infinity;
    const value     = carriedValue();
    const count     = beliefs.carriedParcels.length;

    // Picco di valore del carico corrente
    if (value > batchPeak) batchPeak = value;

    // Rileva un nuovo pickup → resetta il timer "ultimo pickup"
    if (lastPickupTime === null || count > prevCarriedCount) lastPickupTime = now;
    prevCarriedCount = count;

    // 1. Capacità piena → consegna (pulita)
    if (count >= capacity) {
        console.log(`[OPTIONS] Capacità piena → consegna`);
        deliverReason = 'threshold';
        return (deliverLatch = true);
    }

    // 2. Trigger: troppo tempo senza raccogliere nuovi pacchi → consegna + abbassa N
    if (now - lastPickupTime > NO_PICKUP_TIMEOUT) {
        N_current = Math.max(N_MIN, N_current - N_REDUCE_STEP);
        console.log(`[OPTIONS] ${NO_PICKUP_TIMEOUT}ms senza pickup → consegna, N = ${N_current.toFixed(1)}`);
        deliverReason = 'trigger';
        return (deliverLatch = true);
    }

    // 3. Trigger: valore decaduto sotto soglia rispetto al picco → consegna + abbassa N
    if (batchPeak > 0 && value < batchPeak * DECAY_THRESHOLD) {
        N_current = Math.max(N_MIN, N_current - N_REDUCE_STEP);
        console.log(`[OPTIONS] Decay <${(DECAY_THRESHOLD * 100) | 0}% del picco → consegna, N = ${N_current.toFixed(1)}`);
        deliverReason = 'trigger';
        return (deliverLatch = true);
    }

    // 4. Soglia di accumulo raggiunta → consegna (pulita)
    if (value >= N_current * avgReward) {
        console.log(`[OPTIONS] Soglia: ${value.toFixed(0)} ≥ ${(N_current * avgReward).toFixed(0)} → consegna`);
        deliverReason = 'threshold';
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