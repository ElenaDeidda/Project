// beliefs.js — Stato del mondo e funzioni di aggiornamento
import { smartDist /*, isMoving */ } from './basic_functions.js';

export const beliefs = {
    me:            { id: '', name: '', x: 0, y: 0, score: 0 },
    config:        {},
    mapTiles:      new Map(),
    deliveryPoints:[],
    spawnPoints:   [], // <-- NUOVO: memorizziamo dove nascono i pacchi
    parcels:       new Map(),
    carrying:      false,
    carriedParcels:[],

    // --- GESTIONE ALTRI AGENTI COMMENTATA ---
    // agentHistory:  new Map(),
};

export function updateConfig(config) {
    beliefs.config = config;
}

export function updateMap(width, height, tiles) {
    // Svuotiamo gli array prima di aggiornarli
    beliefs.deliveryPoints = [];
    beliefs.spawnPoints = [];

    for (const tile of tiles) {
        const key = `${tile.x}_${tile.y}`;
        beliefs.mapTiles.set(key, {type: tile.type });

        if (tile.type === '2') {
            beliefs.deliveryPoints.push({ x: tile.x, y: tile.y });
        } else if (tile.type === '1') {
            beliefs.spawnPoints.push({ x: tile.x, y: tile.y }); // <-- Salviamo gli spawn point
        }
    }
}

export function updateSensing(sensing) {
    beliefs.parcels.clear();
    for (const p of sensing.parcels) {
        if (!p.carriedBy || p.carriedBy === beliefs.me.id) {
            beliefs.parcels.set(p.id, { id: p.id, x: p.x, y: p.y, reward: p.reward, carriedBy: p.carriedBy ?? null });
        }
    }
    console.log(`[updateSensing] parcels visibili:`, beliefs.parcels.size);

    const mine = sensing.parcels.filter(p => p.carriedBy === beliefs.me.id);
    beliefs.carrying       = mine.length > 0;
    beliefs.carriedParcels = mine;
    console.log(`[updateSensing] carrying:`, beliefs.carrying);

    // --- GESTIONE ALTRI AGENTI COMMENTATA ---
    // _updateAgentHistory(sensing.agents);
}

function _updateAgentHistory(agents) {
    const now     = Date.now();
    const obsDist = beliefs.config?.GAME?.player?.observation_distance ?? 5;
    const seenIds = new Set(agents.map(a => a.id));

    for (const a of agents) {
        if (!a.x || !a.y || isMoving(a)) continue;

        if (!beliefs.agentHistory.has(a.id)) {
            beliefs.agentHistory.set(a.id, [{ name: a.name, x: a.x, y: a.y, timestamp: now, direction: 'none' }]);
            console.log(`[agentHistory] NUOVO agente "${a.name}" (${a.id}) @ (${a.x},${a.y})`);
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
                if (last.x !== a.x || last.y !== a.y) {
                    history.push({ name: a.name, x: a.x, y: a.y, timestamp: now, direction: dir });
                    console.log(`[agentHistory] MOSSO "${a.name}" (${a.id}) → (${a.x},${a.y}) dir:${dir}`);
                } else {
                    console.log(`[agentHistory] FERMO "${a.name}" (${a.id}) @ (${a.x},${a.y})`);
                }
            } else {
                history.push({ name: a.name, x: a.x, y: a.y, timestamp: now, direction: dir });
                console.log(`[agentHistory] RIAPPARSO "${a.name}" (${a.id}) @ (${a.x},${a.y}) dir:${dir}`);
            }
        }
    }

    for (const [id, history] of beliefs.agentHistory.entries()) {
        if (seenIds.has(id)) continue;
        const last      = history[history.length - 1];
        const lastKnown = _findLastKnownPos(history);
        if (typeof last === 'object') {
            history.push('lost');
            console.log(`[agentHistory] LOST agente (${id}), ultima pos: (${lastKnown?.x},${lastKnown?.y})`);
        } else if (lastKnown && smartDist(beliefs.me, lastKnown) < obsDist) {
            beliefs.agentHistory.delete(id);
            console.log(`[agentHistory] RIMOSSO agente (${id}), era lost e dentro obs range`);
        }
    }

    console.log(`[agentHistory] agenti tracciati:`, beliefs.agentHistory.size);
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
    console.log(`[getKnownAgentPositions] posizioni note:`, out);
    return out;
}