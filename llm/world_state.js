// world_state.js
// Read-helper puri sui `beliefs`: snapshot del mondo per l'LLM (snapshotWorld)
// e query deterministiche usate da tool, executor e planner.

import { parseIntervalMs } from '../bdi/basic_functions.js';

// ─── SNAPSHOT DEL MONDO (tool `inspect`): beliefs in forma testuale compatta ──
// Per esporre un nuovo campo all'LLM, aggiungilo qui.

function snapshotWorld(beliefs, activeRules = {}) {
    const me = beliefs.me ?? {};
    const lines = [];

    // Identita + stato
    lines.push(`me: id=${me.id} name=${me.name} team=${me.teamName}(${me.teamId})`);
    lines.push(`position: x=${Math.round(me.x)} y=${Math.round(me.y)} score=${me.score ?? '?'}`);

    // Carico
    const carried = beliefs.carriedParcels ?? [];
    if (carried.length === 0) {
        lines.push('carrying: none');
    } else {
        lines.push(`carrying: ${carried.length} parcels [${
            carried.map(p => `${p.id}(reward=${p.reward})`).join(', ')
        }]`);
    }

    // Mappa: bordi e tipo
    const mapTiles = beliefs.mapTiles ?? new Map();
    if (mapTiles.size > 0) {
        const xs = [], ys = [];
        for (const k of mapTiles.keys()) {
            const [x, y] = k.split('_').map(Number);
            xs.push(x); ys.push(y);
        }
        lines.push(`map_bounds: xmin=${Math.min(...xs)} xmax=${Math.max(...xs)} ymin=${Math.min(...ys)} ymax=${Math.max(...ys)} tiles=${mapTiles.size} directional=${!!beliefs.isDirectionalMap}`);
    } else {
        lines.push('map_bounds: not loaded');
    }

    // Delivery points
    const dps = beliefs.deliveryPoints ?? [];
    lines.push(`delivery_points (${dps.length}) [drop parcels HERE to score]: ${
        dps.length ? dps.map(d => `(${d.x},${d.y})`).join(' ') : 'none'
    }`);

    // Spawn tile (dove appaiono i pacchi, NON delivery): top-N per visibilita.
    const spawnVis = beliefs.spawnVisibility ?? new Map();
    if (spawnVis.size > 0) {
        const top = [...spawnVis.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);
        const list = top.map(([key, vis]) => {
            const [x, y] = key.split('_').map(Number);
            return `(${x},${y}) vis=${vis}`;
        }).join(' ');
        lines.push(`top_spawn_tiles (${spawnVis.size} total) [parcels APPEAR here]: ${list}`);
    }

    // Pacchi visibili
    const parcels = [...(beliefs.parcels?.values() ?? [])];
    const free    = parcels.filter(p => !p.carriedBy);
    if (free.length === 0) {
        lines.push('visible_free_parcels: none');
    } else {
        lines.push(`visible_free_parcels (${free.length}):`);
        for (const p of free) {
            lines.push(`  id=${p.id} at=(${Math.round(p.x)},${Math.round(p.y)}) reward=${Math.round(p.reward)}`);
        }
    }

    // Agenti visibili. Saltiamo i phantom di forbidden_tile (chiave __forbidden_).
    const agentEntries = [...(beliefs.agents?.entries() ?? [])]
        .filter(([k]) => !String(k).startsWith('__forbidden_'));
    if (agentEntries.length === 0) {
        lines.push('visible_agents: none');
    } else {
        lines.push(`visible_agents (${agentEntries.length}):`);
        for (const [, a] of agentEntries) {
            lines.push(`  at=(${Math.round(a.x)},${Math.round(a.y)}) moving=${a.moving} dir=${a.direction}`);
        }
    }

    // Regole L2 attive
    const ruleKeys = Object.keys(activeRules);
    if (ruleKeys.length > 0) {
        lines.push(`active_rules: ${JSON.stringify(activeRules)}`);
    } else {
        lines.push('active_rules: none');
    }

    // Config rilevante per le decisioni
    const cfg = beliefs.config?.GAME ?? {};
    const cfgBits = [];
    if (cfg.player?.capacity            != null) cfgBits.push(`capacity=${cfg.player.capacity}`);
    if (cfg.player?.observation_distance!= null) cfgBits.push(`obs_dist=${cfg.player.observation_distance}`);
    if (cfg.player?.movement_duration   != null) cfgBits.push(`move_ms=${cfg.player.movement_duration}`);
    if (cfg.parcels?.decaying_event     != null) cfgBits.push(`decay=${cfg.parcels.decaying_event}`);
    if (cfg.parcels?.reward_avg         != null) cfgBits.push(`reward_avg=${cfg.parcels.reward_avg}`);
    if (cfgBits.length) lines.push(`game_config: ${cfgBits.join(' ')}`);

    return lines.join('\n');
}


// Delivery point piu vicino a me (null se non ne conosco).
function nearestDelivery(beliefs) {
    const dps = beliefs.deliveryPoints ?? [];
    if (dps.length === 0) return null;
    const me = beliefs.me ?? { x: 0, y: 0 };
    let best = null, bestD = Infinity;
    for (const d of dps) {
        const dist = Math.abs(d.x - me.x) + Math.abs(d.y - me.y);
        if (dist < bestD) { best = d; bestD = dist; }
    }
    return best;
}


// ── ACQUIRE PERSISTENTE: parametri (allineati al patrol del BDI in options.js) ─
const ACQUIRE_WAIT_FACTOR   = 2;        // attesa spawn tile = factor × intervallo generazione
const ACQUIRE_WAIT_FALLBACK = 4000;     // ms, se l'intervallo non e leggibile
const ACQUIRE_POLL_MS       = 250;      // poll di beliefs.parcels durante l'attesa
// Tetto massimo della ricerca. 0 = nessun tetto (cerca finche trova o la coda interrompe).
const ACQUIRE_MAX_MS        = Number(process.env.ACQUIRE_MAX_MS) || 0;

// Distanza di osservazione corrente (default 5 come da SDK).
function obsDistOf(beliefs) {
    return beliefs.config?.GAME?.player?.observation_distance ?? 5;
}

// Pacco libero visibile (entro obs_distance) piu vicino a me; ignora i fantasmi
// fuori vista (inseguirli porta a "Nessun pacco qui").
function nearestVisibleParcel(beliefs) {
    const me  = beliefs.me ?? { x: 0, y: 0 };
    const obs = obsDistOf(beliefs);
    const visible = [...(beliefs.parcels?.values() ?? [])]
        .filter(p => !p.carriedBy)
        .filter(p => (Math.abs(p.x - me.x) + Math.abs(p.y - me.y)) <= obs);
    if (visible.length === 0) return null;
    visible.sort((a, b) =>
        (Math.abs(a.x - me.x) + Math.abs(a.y - me.y)) -
        (Math.abs(b.x - me.x) + Math.abs(b.y - me.y)));
    return visible[0];
}

// Spawn tile migliore (alta visibilita, vicina): dove andare a cercare pacchi.
function bestSpawnTile(beliefs) {
    const spawnVis = beliefs.spawnVisibility ?? new Map();
    if (spawnVis.size === 0) return null;
    const me = beliefs.me ?? { x: 0, y: 0 };
    let best = null, bestScore = -Infinity;
    for (const [key, vis] of spawnVis.entries()) {
        const [x, y] = key.split('_').map(Number);
        const score = vis * 10 - (Math.abs(x - me.x) + Math.abs(y - me.y));
        if (score > bestScore) { best = { x, y }; bestScore = score; }
    }
    return best;
}

// Spawn tile ordinate best-first (score di bestSpawnTile); per ruotare tra le tile.
function rankedSpawnTiles(beliefs) {
    const spawnVis = beliefs.spawnVisibility ?? new Map();
    const me = beliefs.me ?? { x: 0, y: 0 };
    const tiles = [];
    for (const [key, vis] of spawnVis.entries()) {
        const [x, y] = key.split('_').map(Number);
        const score = vis * 10 - (Math.abs(x - me.x) + Math.abs(y - me.y));
        tiles.push({ x, y, key, score });
    }
    tiles.sort((a, b) => b.score - a.score);
    return tiles;
}

// Attesa su una spawn tile prima di ruotare: 2× l'intervallo di generazione
// (parseIntervalMs ritorna Infinity per 'infinite'/non leggibile -> fallback).
function acquireWaitMs(beliefs) {
    const p  = beliefs.config?.GAME?.parcels;
    const ms = parseIntervalMs(p?.generation_event ?? p?.generation_time);
    return Number.isFinite(ms) ? ms * ACQUIRE_WAIT_FACTOR : ACQUIRE_WAIT_FALLBACK;
}


// Coordinata [x,y] o {x,y} -> stringa "x,y" (null se non valida).
function coordStr(at) {
    if (Array.isArray(at) && at.length >= 2 && at[0] != null && at[1] != null)
        return `${Math.round(at[0])},${Math.round(at[1])}`;
    if (at && typeof at === 'object' && at.x != null && at.y != null)
        return `${Math.round(at.x)},${Math.round(at.y)}`;
    return null;
}

// Tra piu candidati, scegli il piu vicino a me. Ritorna [x,y] o null.
function nearestCandidate(cands, me) {
    const m = me ?? { x: 0, y: 0 };
    let best = null, bestD = Infinity;
    for (const c of cands ?? []) {
        const cc = Array.isArray(c) ? { x: c[0], y: c[1] } : c;
        if (cc?.x == null || cc?.y == null) continue;
        const d = Math.abs(cc.x - m.x) + Math.abs(cc.y - m.y);
        if (d < bestD) { best = [cc.x, cc.y]; bestD = d; }
    }
    return best;
}

export {
    snapshotWorld, obsDistOf, nearestDelivery, nearestVisibleParcel,
    bestSpawnTile, rankedSpawnTiles, acquireWaitMs, coordStr, nearestCandidate,
    ACQUIRE_WAIT_FACTOR, ACQUIRE_WAIT_FALLBACK, ACQUIRE_POLL_MS, ACQUIRE_MAX_MS,
};
