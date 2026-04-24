// beliefs.js — Stato del mondo e funzioni di aggiornamento
import { smartDist, isMoving } from './basic_functions.js';

export const beliefs = {
    me:            { id: '', name: '', x: 0, y: 0, score: 0 },
    config:        {},
    mapTiles:      new Map(),   // key="x_y", value={x,y,type}
    deliveryPoints:[],          // [{x,y}]
    parcels:       new Map(),   // Map<id, {id,x,y,reward,carriedBy}>
    agentHistory:  new Map(),   // Map<id, [{name,x,y,timestamp,direction}|'lost']>
    carrying:      false,
    carriedParcels:[],
};

export function updateConfig(config) {
    beliefs.config = config;
    console.log(`[BELIEFS] Observation distance: ${config?.GAME?.player?.observation_distance ?? '?'}`);
}

export function updateMap(width, height, tiles) {
    for (const tile of tiles) {
        const key = `${tile.x}_${tile.y}`;
        beliefs.mapTiles.set(key, { x: tile.x, y: tile.y, type: tile.type });
        if (tile.type === 2 || tile.type === 'delivery') {
            const exists = beliefs.deliveryPoints.some(p => p.x === tile.x && p.y === tile.y);
            if (!exists) beliefs.deliveryPoints.push({ x: tile.x, y: tile.y });
        }
    }
}

export function updateSensing(sensing) {
    // Aggiorna pacchi visibili
    beliefs.parcels.clear();
    for (const p of sensing.parcels) {
        if (!p.carriedBy || p.carriedBy === beliefs.me.id) {
            beliefs.parcels.set(p.id, { id: p.id, x: p.x, y: p.y, reward: p.reward, carriedBy: p.carriedBy ?? null });
        }
    }
    // Aggiorna stato trasporto
    const mine = sensing.parcels.filter(p => p.carriedBy === beliefs.me.id);
    beliefs.carrying       = mine.length > 0;
    beliefs.carriedParcels = mine;
    // Aggiorna storico agenti
    _updateAgentHistory(sensing.agents);
}

function _updateAgentHistory(agents) {
    const now     = Date.now();
    const obsDist = beliefs.config?.GAME?.player?.observation_distance ?? 5;
    const seenIds = new Set(agents.map(a => a.id));

    for (const a of agents) {
        if (!a.x || !a.y || isMoving(a)) continue;

        if (!beliefs.agentHistory.has(a.id)) {
            beliefs.agentHistory.set(a.id, [{ name: a.name, x: a.x, y: a.y, timestamp: now, direction: 'none' }]);
        } else {
            const history = beliefs.agentHistory.get(a.id);
            const last    = history[history.length - 1];
            const prev    = typeof last === 'object' ? last : _findLastKnownPos(history);
            let dir = 'none';
            if (prev) {
                if (prev.x < a.x) dir = 'right';
                else if (prev.x > a.x) dir = 'left';
                else if (prev.y < a.y) dir = 'up';
                else if (prev.y > a.y) dir = 'down';
            }
            if (typeof last === 'object') {
                if (last.x !== a.x || last.y !== a.y)
                    history.push({ name: a.name, x: a.x, y: a.y, timestamp: now, direction: dir });
            } else {
                history.push({ name: a.name, x: a.x, y: a.y, timestamp: now, direction: dir });
            }
        }
    }

    for (const [id, history] of beliefs.agentHistory.entries()) {
        if (seenIds.has(id)) continue;
        const last      = history[history.length - 1];
        const lastKnown = _findLastKnownPos(history);
        if (typeof last === 'object') {
            history.push('lost');
        } else if (lastKnown && smartDist(beliefs.me, lastKnown) < obsDist) {
            beliefs.agentHistory.delete(id);
        }
    }
}

function _findLastKnownPos(history) {
    for (let i = history.length - 1; i >= 0; i--)
        if (typeof history[i] === 'object') return history[i];
    return null;
}

export function getKnownAgentPositions() {
    const out = [];
    for (const history of beliefs.agentHistory.values()) {
        const last = history[history.length - 1];
        if (typeof last === 'object') out.push({ x: last.x, y: last.y });
    }
    return out;
}