// rules_engine.js
// ─────────────────────────────────────────────────────────────────────────────
// Motore delle regole L2 (strategia v2, pezzo 3).
// Le regole vengono installate dall'executor (installRule) e applicate dal
// loop BDI dell'agente LLM ad ogni ciclo, in tre punti:
//   - applyRulesToBeliefs   → post-processa i beliefs dopo updateSensing
//   - applyRulesAsActions   → azioni concrete sul mondo (es. scaricare extra)
//   - applyRulesToPredicate → modifica la decisione del BDI prima di eseguirla
//
// NOVITÀ rispetto alla v1 (che stava inline in llm_main.js):
//
// 1. forbidden_tile = MURO nella mappa (non più "agente fantasma"):
//    la tile viene marcata type '0' in beliefs.mapTiles → A*, BFS e tutto il
//    pathfinding la trattano come non percorribile, anche come DESTINAZIONE
//    (il phantom-agent non proteggeva la tile se era il target del percorso).
//
// 2. max_parcel_reward = STRATEGIA DEL TIMER (non più "ignora i pacchi ricchi"):
//    la regola dice "consegnare pacchi con valore > soglia non dà punti".
//    I pacchi però DECADONO nel tempo: un pacco ricco è punteggio futuro.
//    Strategia (dal documento di strategia):
//      - raccogli pure pacchi ricchi e tienili in mano mentre decadono;
//      - il "timer" è il valore corrente del pacco più ricco trasportato;
//      - raccogli solo pacchi nella finestra [timer - soglia/2, timer], così
//        lo stack resta compatto e attraversa la soglia più o meno insieme;
//      - parti verso la delivery quando timer ≤ soglia + decay_del_viaggio:
//        all'arrivo ogni pacco vale ≤ soglia e i punti sono il massimo possibile.
//    Se la partita NON ha decay (decaying_event assente/infinito) la strategia
//    è impossibile → fallback alla v1: niente pickup sopra soglia.
// ─────────────────────────────────────────────────────────────────────────────

import { parseIntervalMs } from './basic_functions.js';

// ═════════════════════════════════════════════════════════════════════════════
// INSTALLAZIONE — chiamata dall'executor quando il parser produce una regola
// ═════════════════════════════════════════════════════════════════════════════

// Normalizza le tile di una regola: accetta {tiles:[[x,y],...]} o {x,y} secchi.
function ruleTiles(rule) {
    if (Array.isArray(rule.tiles)) {
        return rule.tiles
            .map(t => Array.isArray(t) ? { x: Number(t[0]), y: Number(t[1]) }
                                       : { x: Number(t?.x), y: Number(t?.y) })
            .filter(t => Number.isFinite(t.x) && Number.isFinite(t.y));
    }
    if (Number.isFinite(Number(rule.x)) && Number.isFinite(Number(rule.y))) {
        return [{ x: Number(rule.x), y: Number(rule.y) }];
    }
    return [];
}

function pushTiles(list = [], tiles) {
    for (const t of tiles) {
        if (!list.some(e => e.x === t.x && e.y === t.y)) list.push(t);
    }
    return list;
}

// Mura una tile nella mappa dei beliefs (e ricorda il tipo originale per
// poterla eventualmente ripristinare con clear_rule).
function wallTile(t, rules, beliefs) {
    const key  = `${t.x}_${t.y}`;
    const tile = beliefs.mapTiles.get(key);
    if (!tile || tile.type === '0') return;
    rules._wallOriginals = rules._wallOriginals || {};
    rules._wallOriginals[key] = tile.type;
    beliefs.mapTiles.set(key, { ...tile, type: '0' });
    // Se era una delivery, non deve più essere un target di consegna
    beliefs.deliveryPoints = (beliefs.deliveryPoints ?? [])
        .filter(d => !(d.x === t.x && d.y === t.y));
}

/**
 * Installa una regola strutturata (dal parser) in `rules` + side-effects
 * immediati sui beliefs (es. murare le forbidden tile).
 * @returns {string} messaggio per i log
 * @throws  se la regola è malformata
 */
export function installRule(rule, rules, beliefs) {
    switch (rule.type) {
        case 'stack_size': {
            const n = Number(rule.n);
            if (!Number.isInteger(n) || n < 1) throw new Error(`stack_size: n non valido (${rule.n})`);
            rules.stackSize = n;
            return `regola installata: stackSize=${n}`;
        }
        case 'max_parcel_reward': {
            const v = Number(rule.value);
            if (!Number.isFinite(v)) throw new Error(`max_parcel_reward: value non valido (${rule.value})`);
            rules.maxParcelReward = v;
            return `regola installata: maxParcelReward=${v} (strategia timer)`;
        }
        case 'forbidden_tile': {
            const tiles = ruleTiles(rule);
            if (!tiles.length) throw new Error('forbidden_tile senza coordinate');
            rules.forbiddenTiles = pushTiles(rules.forbiddenTiles, tiles);
            for (const t of tiles) wallTile(t, rules, beliefs);
            return `regola installata: forbidden ${tiles.map(t => `(${t.x},${t.y})`).join(' ')} → murate`;
        }
        case 'zero_delivery': {
            const tiles = ruleTiles(rule);
            if (!tiles.length) throw new Error('zero_delivery senza coordinate');
            rules.zeroDeliveries = pushTiles(rules.zeroDeliveries, tiles);
            return `regola installata: zero_delivery ${tiles.map(t => `(${t.x},${t.y})`).join(' ')}`;
        }
        case 'bonus_delivery': {
            const tiles = ruleTiles(rule);
            if (!tiles.length) throw new Error('bonus_delivery senza coordinate');
            rules.bonusDeliveries = pushTiles(rules.bonusDeliveries, tiles);
            return `regola installata: bonus_delivery ${tiles.map(t => `(${t.x},${t.y})`).join(' ')}`;
        }
        default:
            throw new Error(`tipo di regola sconosciuto: ${rule.type}`);
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// STRATEGIA DEL TIMER (max_parcel_reward) — helper esportati anche per i test
// ═════════════════════════════════════════════════════════════════════════════

// Decay del reward durante un viaggio di `steps` passi: ogni passo dura
// movement_duration ms, ogni decaying_event ms il pacco perde 1 punto.
export function travelDecay(steps, beliefs) {
    const moveMs  = beliefs.config?.GAME?.player?.movement_duration ?? 500;
    const decayMs = parseIntervalMs(beliefs.config?.GAME?.parcels?.decaying_event);
    if (!Number.isFinite(decayMs) || decayMs <= 0) return 0;   // niente decay
    return (steps * moveMs) / decayMs;
}

export function hasDecay(beliefs) {
    const decayMs = parseIntervalMs(beliefs.config?.GAME?.parcels?.decaying_event);
    return Number.isFinite(decayMs) && decayMs > 0;
}

// È il momento di partire verso la delivery? Sì se il pacco più ricco,
// decaduto del viaggio, arriverà sotto soglia.
export function shouldDepart(maxCarried, stepsToDelivery, soglia, beliefs) {
    return maxCarried - travelDecay(stepsToDelivery, beliefs) <= soglia;
}

function maxCarriedValue(beliefs) {
    const carried = beliefs.carriedParcels ?? [];
    return carried.length ? Math.max(...carried.map(p => p.reward ?? 0)) : 0;
}

function dist(a, b) { return Math.abs(a.x - b.x) + Math.abs(a.y - b.y); }

// Il miglior pacco libero DENTRO la finestra del timer [max-soglia/2, max]:
// tiene lo stack compatto in valore. Null se non ce n'è.
function bestParcelInWindow(beliefs, soglia) {
    const maxC = maxCarriedValue(beliefs);
    const lo   = maxC - soglia / 2;
    const free = [...(beliefs.parcels?.values() ?? [])]
        .filter(p => !p.carriedBy && (p.reward ?? 0) >= lo && (p.reward ?? 0) <= maxC);
    if (free.length === 0) return null;
    // più vicino a me, a parità di tutto
    free.sort((a, b) => dist(a, beliefs.me) - dist(b, beliefs.me));
    return free[0];
}

// ═════════════════════════════════════════════════════════════════════════════
// HELPER condivisi (ex llm_main.js)
// ═════════════════════════════════════════════════════════════════════════════

function nearestFreeParcel(beliefs) {
    const free = [...(beliefs.parcels?.values() ?? [])].filter(p => !p.carriedBy);
    if (free.length === 0) return null;
    free.sort((a, b) => dist(a, beliefs.me) - dist(b, beliefs.me));
    return free[0];
}

function bestSpawnTile(beliefs) {
    const spawnVis = beliefs.spawnVisibility ?? new Map();
    if (spawnVis.size === 0) return null;
    let best = null, bestScore = -Infinity;
    for (const [key, vis] of spawnVis.entries()) {
        const [x, y] = key.split('_').map(Number);
        const score = vis * 10 - dist({ x, y }, beliefs.me);
        if (score > bestScore) { best = { x, y }; bestScore = score; }
    }
    return best;
}

function isTileOccupiedByEnemy(tile, beliefs) {
    for (const a of beliefs.agents.values()) {
        if (Math.round(a.x) === tile.x && Math.round(a.y) === tile.y) return true;
        if (a.moving && a.targetX === tile.x && a.targetY === tile.y) return true;
    }
    return false;
}

// Quando una regola blocca il 'deliver', l'agente deve comunque fare qualcosa
// di utile: un pickup sensato, o presidiare una spawn tile.
function redirectAwayFromDeliver(beliefs, soglia = null) {
    const p = (soglia !== null && (beliefs.carriedParcels?.length ?? 0) > 0)
        ? bestParcelInWindow(beliefs, soglia)
        : nearestFreeParcel(beliefs);
    if (p) return ['go_pick_up', Math.round(p.x), Math.round(p.y), p.id, p.reward];
    const s = bestSpawnTile(beliefs);
    if (s) return ['go_to_spawn', s.x, s.y];
    return ['go_to_spawn'];   // GoToSpawn senza coordinate = attesa sul posto
}

// ═════════════════════════════════════════════════════════════════════════════
// APPLICAZIONE — chiamate dal loop BDI dell'agente LLM (llm_main.js)
// ═════════════════════════════════════════════════════════════════════════════

export function applyRulesToBeliefs(rules, beliefs) {
    // forbidden_tile: i muri sono permanenti in mapTiles (installati una volta),
    // ma un pacco spawnnato SOPRA una tile murata è irraggiungibile → via dai
    // beliefs, sennò il BDI lo insegue per sempre.
    if (Array.isArray(rules.forbiddenTiles)) {
        for (const [id, p] of beliefs.parcels) {
            if (rules.forbiddenTiles.some(t => t.x === Math.round(p.x) && t.y === Math.round(p.y))) {
                beliefs.parcels.delete(id);
            }
        }
    }

    // max_parcel_reward SENZA decay: la strategia timer è impossibile →
    // fallback v1: i pacchi sopra soglia non esistono per il BDI.
    if (typeof rules.maxParcelReward === 'number' && !hasDecay(beliefs)) {
        for (const [id, p] of beliefs.parcels) {
            if ((p.reward ?? 0) > rules.maxParcelReward) beliefs.parcels.delete(id);
        }
    }
}

export async function applyRulesAsActions(socket, beliefs, rules) {
    const carried = beliefs.carriedParcels ?? [];
    if (carried.length === 0) return;

    // Su una delivery tile qualsiasi putdown consegnerebbe tutto: niente drop.
    const x = Math.round(beliefs.me.x);
    const y = Math.round(beliefs.me.y);
    if ((beliefs.deliveryPoints ?? []).some(d => d.x === x && d.y === y)) return;

    const idsToDrop = new Set();

    // max_parcel_reward SENZA decay: scarico i pacchi sopra soglia (con il
    // decay invece li TENGO: scenderanno da soli — strategia timer).
    if (typeof rules.maxParcelReward === 'number' && !hasDecay(beliefs)) {
        for (const p of carried) {
            if ((p.reward ?? 0) > rules.maxParcelReward) idsToDrop.add(p.id);
        }
    }

    // stack_size: se porto più di N, scarico gli extra tenendo gli N migliori.
    if (Number.isInteger(rules.stackSize) && carried.length > rules.stackSize) {
        const stillKept = carried.filter(p => !idsToDrop.has(p.id));
        if (stillKept.length > rules.stackSize) {
            const sorted = [...stillKept].sort((a, b) => (b.reward ?? 0) - (a.reward ?? 0));
            for (const p of sorted.slice(rules.stackSize)) idsToDrop.add(p.id);
        }
    }

    if (idsToDrop.size > 0) {
        const ids = [...idsToDrop];
        console.log(`[RULES] scarico ${ids.length} pacchi non conformi: ${ids.join(',')} @(${x},${y})`);
        try { await socket.emitPutdown(ids); }
        catch (e) { console.warn(`[RULES] emitPutdown fallito: ${e?.message ?? e}`); }
    }
}

export function applyRulesToPredicate(predicate, rules, beliefs) {
    if (!predicate) return predicate;
    const [action, ...args] = predicate;
    const soglia = typeof rules.maxParcelReward === 'number' ? rules.maxParcelReward : null;

    // ── STRATEGIA TIMER (solo con decay attivo) ──────────────────────────────
    if (soglia !== null && hasDecay(beliefs)) {
        const carried = beliefs.carriedParcels ?? [];
        const maxC    = maxCarriedValue(beliefs);

        // PICKUP: tieni lo stack nella finestra [maxC - soglia/2, maxC].
        // (Se non porto nulla, qualsiasi pacco va bene: diventa lui il timer.)
        if (action === 'go_pick_up' && carried.length > 0) {
            const reward = args[3];
            const lo = maxC - soglia / 2;
            if (reward != null && (reward < lo || reward > maxC)) {
                const alt = bestParcelInWindow(beliefs, soglia);
                if (alt) {
                    console.log(`[RULES] timer: pacco ${args[2]} (${reward}pt) fuori finestra [${lo.toFixed(1)},${maxC.toFixed(1)}] → ${alt.id} (${alt.reward}pt)`);
                    return ['go_pick_up', Math.round(alt.x), Math.round(alt.y), alt.id, alt.reward];
                }
                // Nessun pacco in finestra: se è ora di partire consegno,
                // altrimenti aspetto che il timer scenda.
                const dp = nearestDeliveryTo(beliefs);
                if (dp && shouldDepart(maxC, dist(dp, beliefs.me), soglia, beliefs)) {
                    console.log(`[RULES] timer: niente in finestra e timer=${maxC.toFixed(1)} maturo → consegno a (${dp.x},${dp.y})`);
                    return ['deliver', dp.x, dp.y];
                }
                console.log(`[RULES] timer: niente in finestra, timer=${maxC.toFixed(1)} ancora alto → attendo il decay`);
                return ['go_to_spawn'];
            }
        }

        // DELIVER: parti solo quando all'arrivo TUTTO lo stack sarà ≤ soglia.
        if (action === 'deliver' && carried.length > 0) {
            const [dx, dy] = args;
            const steps = dist({ x: dx, y: dy }, beliefs.me);
            if (!shouldDepart(maxC, steps, soglia, beliefs)) {
                const eta = maxC - travelDecay(steps, beliefs) - soglia;
                console.log(`[RULES] timer: troppo presto per consegnare (arriverei ${eta.toFixed(1)}pt sopra soglia) → continuo a raccogliere`);
                return redirectAwayFromDeliver(beliefs, soglia);
            }
        }
    }

    // ── stack_size: consegna solo con ESATTAMENTE N pacchi ──────────────────
    if (Number.isInteger(rules.stackSize) && action === 'deliver') {
        const N = rules.stackSize;
        const carried = beliefs.carriedParcels?.length ?? 0;
        if (carried < N) {
            const alt = redirectAwayFromDeliver(beliefs);
            console.log(`[RULES] stackSize=${N}: porto ${carried} → ${alt[0]}(${alt.slice(1).join(',')})`);
            return alt;
        }
    }

    // ── zero_delivery: la tile target è vietata → la più vicina permessa ────
    if (Array.isArray(rules.zeroDeliveries) && action === 'deliver') {
        const [x, y] = args;
        if (rules.zeroDeliveries.some(t => t.x === x && t.y === y)) {
            const alts = (beliefs.deliveryPoints || []).filter(
                d => !rules.zeroDeliveries.some(t => t.x === d.x && t.y === d.y)
            );
            if (alts.length === 0) {
                console.log(`[RULES] zeroDelivery: nessuna delivery permessa → redirect`);
                return redirectAwayFromDeliver(beliefs);
            }
            alts.sort((a, b) => dist(a, beliefs.me) - dist(b, beliefs.me));
            console.log(`[RULES] zeroDelivery: (${x},${y}) vietata → (${alts[0].x},${alts[0].y})`);
            return ['deliver', alts[0].x, alts[0].y];
        }
    }

    // ── bonus_delivery: preferisci la tile bonus se libera e non troppo lontana
    if (Array.isArray(rules.bonusDeliveries) && action === 'deliver') {
        const [x, y] = args;
        const targetIsBonus = rules.bonusDeliveries.some(t => t.x === x && t.y === y);
        if (!targetIsBonus) {
            const myDist = dist({ x, y }, beliefs.me);
            for (const b of rules.bonusDeliveries) {
                if (isTileOccupiedByEnemy(b, beliefs)) {
                    console.log(`[RULES] bonusDelivery: (${b.x},${b.y}) occupata da nemico, skip`);
                    continue;
                }
                if (dist(b, beliefs.me) <= myDist + 5) {
                    console.log(`[RULES] bonusDelivery: ridiretto da (${x},${y}) a bonus (${b.x},${b.y})`);
                    return ['deliver', b.x, b.y];
                }
            }
        }
    }

    return predicate;
}

function nearestDeliveryTo(beliefs) {
    const dps = beliefs.deliveryPoints ?? [];
    if (dps.length === 0) return null;
    return dps.reduce((best, d) => dist(d, beliefs.me) < dist(best, beliefs.me) ? d : best);
}
