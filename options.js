// options.js — Generazione opzioni e deliberazione
import { beliefs, getAgentPositions, getBlockedCells } from './beliefs.js';
import { scoreParcel, nearestDeliveryDist, parseIntervalMs }  from './basic_functions.js';
import { reachableDistances } from './moves.js';

// Distanza reale di percorso (da BFS) verso (x,y); ∞ se irraggiungibile
function realDist(dist, x, y) {
    return dist.get(`${Math.round(x)}_${Math.round(y)}`) ?? Infinity;
}

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
const NEAR_DELIVERY_FACTOR = 0.25; // se un delivery è a portata visiva, soglia effettiva = N × questo

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


// Modello di decadimento condiviso tra N (computeInitialN) e scoreParcel,
// così i due ragionano sullo stesso "valore nel tempo".
function decayMsFromConfig() {
    return parseIntervalMs(beliefs.config.GAME?.parcels?.decaying_event);
}

// Reward persi per passo di movimento (0 se il decay è 'infinite')
function decayPerStep() {
    const decayMs = decayMsFromConfig();
    const moveDur = beliefs.config.GAME?.player?.movement_duration ?? 500;
    return Number.isFinite(decayMs) ? moveDur / decayMs : 0;
}

// Valore iniziale di N derivato dalla dinamica di gioco:
//   quanti pacchi riesco a raccogliere prima che il primo perda
//   (1 - DECAY_THRESHOLD) del suo valore, limitato dalla capacità.
function computeInitialN() {
    const cfg       = beliefs.config.GAME ?? {};
    const avgReward = cfg.parcels?.reward_avg          ?? 10;
    const moveDur   = cfg.player?.movement_duration    ?? 500;
    const obsDist   = cfg.player?.observation_distance ?? 5;
    const decayMs   = decayMsFromConfig();    
    const cap       = capacityCap();

    // Nessun decadimento → conviene riempirsi fino alla capacità
    if (!Number.isFinite(decayMs)) return clamp(cap, N_MIN, cap);

    const lossFraction  = 1 - DECAY_THRESHOLD;              // 0.40
    const timeBudget    = lossFraction * avgReward * decayMs; // ms prima della soglia di decay
    const timePerPickup = Math.max(1, obsDist) * moveDur;     // ms stimati per un pickup
    const collectable   = Math.floor(timeBudget / timePerPickup);

    return clamp(collectable, N_MIN, cap);
}

// ─── Pattugliamento spawn ───────────────────────────────────────────────────
// Quando non ci sono pacchi da raccogliere l'agente sosta sulla zona spawn
// migliore; se dopo un timeout (legato al ritmo di generazione) non vede ancora
// pacchi attorno, marca quella zona come "esausta" e si riloca su un'altra.
const PATROL_TIMEOUT_FACTOR   = 2;     // timeout = factor × intervallo di generazione
const PATROL_TIMEOUT_FALLBACK = 4000;  // ms, se generation_event non è leggibile
const EXHAUST_COOLDOWN_FACTOR = 3;     // per quanto una zona resta esclusa (× timeout)
const ENEMY_ZONE_PENALTY      = 5;     // penalità di score per nemico vicino alla tile

let lastPickupSeenTime = Date.now();   // ultima volta con ≥1 pacco raccoglibile visibile
const exhaustedZones   = new Map();    // "x_y" centro zona esausta → scadenza (ms)

function genIntervalMs() {
    const p = beliefs.config.GAME?.parcels ?? {};
    const ms = parseIntervalMs(p.generation_event ?? p.generation_time);
    return Number.isFinite(ms) ? ms : null;
}

function patrolTimeout() {
    const g = genIntervalMs();
    return g != null ? g * PATROL_TIMEOUT_FACTOR : PATROL_TIMEOUT_FALLBACK;
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

    // 4. Soglia di accumulo. Se un delivery è nel raggio visivo, consegnare
    //    costa poco: abbassa la soglia EFFETTIVA (senza toccare N_current, così
    //    l'apprendimento di N resta pulito) e consegna più spesso.
    const obsDist      = beliefs.config.GAME?.player?.observation_distance ?? 5;
    const delDist      = nearestDeliveryDist(beliefs.me, beliefs.deliveryPoints);
    const nearDelivery = beliefs.deliveryPoints.length > 0 && delDist <= obsDist;
    const effN         = nearDelivery ? Math.max(N_MIN, N_current * NEAR_DELIVERY_FACTOR)
                                      : N_current;

    if (value >= effN * avgReward) {
        // 'opportunistic' = consegna anticipata perché il delivery è a portata:
        // NON deve influenzare l'adattamento di N (né su né giù).
        deliverReason = (nearDelivery && effN < N_current) ? 'opportunistic' : 'threshold';
        console.log(`[OPTIONS] Soglia${nearDelivery ? ` (delivery a dist ${delDist} ≤ ${obsDist})` : ''}: ` +
                    `${value.toFixed(0)} ≥ ${(effN * avgReward).toFixed(0)} (effN=${effN.toFixed(1)}) → consegna`);
        return (deliverLatch = true);
    }

    return false;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function isCarrying() {
    return beliefs.carrying || beliefs.carriedParcels.length > 0;
}


// ─── sezioni di generateOptions ───────────────────────────────────────────────

function buildPickupOptions(agentPositions, dist) {
    const options = [];
    const blocked = getBlockedCells();

    for (const [id, parcel] of beliefs.parcels.entries()) {
        // Già portato da qualcuno
        if (parcel.carriedBy) continue;

        // Tile occupata da un agente avversario: non riusciremmo a raccoglierlo
        const key = `${Math.round(parcel.x)}_${Math.round(parcel.y)}`;
        if (blocked.has(key)) continue;

        // Distanza REALE di percorso: se irraggiungibile (muri/nemici) → scarta
        const rd = realDist(dist, parcel.x, parcel.y);
        if (!Number.isFinite(rd)) continue;

        const delDist = nearestDeliveryDist(parcel, beliefs.deliveryPoints);
        const score   = scoreParcel(beliefs.me, parcel, agentPositions, delDist, rd);

        // Scarta subito pacchi con score negativo infinito (reward 0, ecc.)
        if (score === -Infinity) continue;

        options.push(['go_pick_up', parcel.x, parcel.y, id, score]);
    }

    return options;
}

function buildDeliverOptions(dist) {
    // Nessun pacco da consegnare → nessuna opzione
    if (beliefs.deliveryPoints.length === 0) return [];

    const options = [];
    for (const dp of beliefs.deliveryPoints) {
        // Distanza REALE: i delivery bloccati dai nemici / dietro un muro
        // hanno distanza ∞ → vengono scartati, così si sceglie un altro
        // delivery raggiungibile invece di andare in loop su uno irraggiungibile.
        const d = realDist(dist, dp.x, dp.y);
        if (!Number.isFinite(d)) continue;
        options.push(['deliver', dp.x, dp.y, d]);
    }
    return options;
}

// Scompone lo score di una spawn tile nei suoi termini, così formula e log
// usano un'unica fonte di verità.
function spawnScoreBreakdown(x, y, agentPositions, obsDist, dist) {
    const myDist     = realDist(dist, x, y);   // distanza reale di percorso
    const delDist    = nearestDeliveryDist({ x, y }, beliefs.deliveryPoints);
    const visibility = beliefs.spawnVisibility.get(`${x}_${y}`) ?? 0;

    let enemies = 0;
    for (const a of agentPositions)
        if (Math.abs(a.x - x) + Math.abs(a.y - y) <= obsDist) enemies++;

    const prox  = -(myDist + delDist);          // vicinanza a me e a un delivery
    const vis   = visibility * VISIBILITY_BONUS; // visibilità spawn
    const enemy = -enemies * ENEMY_ZONE_PENALTY; // penalità nemici (≤ 0)

    return { score: prox + vis + enemy, prox, vis, enemy, enemies };
}

let _lastPatrolLog = 0;   // throttle dei log di stato del pattugliamento

function buildSpawnOptions(agentPositions, dist) {
    const now     = Date.now();
    const blocked = getBlockedCells();
    const obsDist = beliefs.config.GAME?.player?.observation_distance ?? 5;

    // Purga le zone esauste scadute (lì i pacchi potrebbero essere rinati)
    for (const [k, exp] of exhaustedZones) if (exp <= now) exhaustedZones.delete(k);

    // Trigger di rilocazione: troppo tempo senza pacchi attorno → la zona attuale
    // è esausta, escludila per un cooldown e riavvia la finestra di sosta.
    if (now - lastPickupSeenTime > patrolTimeout()) {
        const cx = Math.round(beliefs.me.x), cy = Math.round(beliefs.me.y);
        const waited = ((now - lastPickupSeenTime) / 1000).toFixed(1);
        exhaustedZones.set(`${cx}_${cy}`, now + patrolTimeout() * EXHAUST_COOLDOWN_FACTOR);
        lastPickupSeenTime = now;
        console.log(`[PATROL] Zona (${cx},${cy}) esausta dopo ${waited}s senza pacchi ` +
                    `(timeout ${(patrolTimeout() / 1000).toFixed(1)}s) → rilocazione | zone esauste: ${exhaustedZones.size}`);
    }

    const exhaustCenters = [...exhaustedZones.keys()].map(k => {
        const [x, y] = k.split('_').map(Number); return { x, y };
    });

    const build = (applyExhaust) => {
        const options = [];
        for (const [key, tile] of beliefs.mapTiles.entries()) {
            if (tile.type !== '1') continue;
            if (blocked.has(key)) continue;          // tile occupata da un agente

            const [x, y] = key.split('_').map(Number);

            // Esclude le tile dentro una zona esausta (raggio = observation_distance)
            if (applyExhaust &&
                exhaustCenters.some(c => Math.abs(c.x - x) + Math.abs(c.y - y) <= obsDist))
                continue;

            const { score } = spawnScoreBreakdown(x, y, agentPositions, obsDist, dist);
            // Spawn tile irraggiungibile ora (muri/nemici) → score ∞ negativo → scarta
            if (!Number.isFinite(score)) continue;
            options.push(['go_to_spawn', x, y, score]);
        }
        return options;
    };

    // Se l'esclusione delle zone esauste non lascia nulla, meglio muoversi
    // comunque che restare bloccati → riprova senza esclusione.
    let options = build(true);
    if (options.length === 0) options = build(false);

    // Log di stato (throttled ~1s) per tarare PATROL_TIMEOUT_FACTOR e ENEMY_ZONE_PENALTY
    if (now - _lastPatrolLog > 1000 && options.length > 0) {
        _lastPatrolLog = now;
        const best = options.reduce((b, c) => c[3] > b[3] ? c : b);
        const bd   = spawnScoreBreakdown(best[1], best[2], agentPositions, obsDist, dist);
        const waited = ((now - lastPickupSeenTime) / 1000).toFixed(1);
        console.log(`[PATROL] attesa ${waited}s / timeout ${(patrolTimeout() / 1000).toFixed(1)}s | ` +
                    `esauste: ${exhaustedZones.size} | best (${best[1]},${best[2]}) score=${bd.score.toFixed(1)} ` +
                    `[prox=${bd.prox} vis=${bd.vis} nemici=${bd.enemies}(${bd.enemy})]`);
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
    // BFS una sola volta: distanze reali di percorso verso tutte le celle,
    // rispettando muri e nemici. Condivisa da delivery / pickup / spawn.
    const dist = reachableDistances(
        beliefs.me, beliefs.mapTiles, getBlockedCells(), beliefs.isDirectionalMap
    );

    if (shouldDeliver()) {
        // In viaggio verso il delivery non siamo "in attesa di spawn":
        // tieni fresca la finestra di pattugliamento.
        lastPickupSeenTime = Date.now();
        return buildDeliverOptions(dist);
    }

    // Non sta portando nulla, OPPURE sta portando ma non ha ancora raggiunto
    // la soglia → continua a cercare pacchi da raccogliere

    const agentPositions = getAgentPositions();
    const pickups        = buildPickupOptions(agentPositions, dist);

    // C'è almeno un pacco raccoglibile visibile → la zona non è "vuota"
    if (pickups.length > 0) lastPickupSeenTime = Date.now();

    return [
        ...pickups,
        ...buildSpawnOptions(agentPositions, dist),
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