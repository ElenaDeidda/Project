// beliefs.js — Stato del mondo e funzioni di aggiornamento
import { smartDist } from './basic_functions.js';

export const beliefs = {
    me:             { id: '', name: '', x: 0, y: 0, score: 0 },
    config:         {},
    mapTiles:       new Map(),
    isDirectionalMap: false,
    deliveryPoints: [],
    parcels:        new Map(),
    agents:         new Map(),   // id → { x, y, moving, direction, targetX, targetY }
    carrying:       false,
    carriedParcels: [],

    // Precalcolato in updateMap():
    // per ogni spawn tile "x_y" → quante spawn tiles sono visibili da quel punto
    spawnVisibility: new Map(),

    // Timeout spawn tile:
    // traccia la tile di spawn corrente e quando ci siamo arrivati.
    // Se dopo SPAWN_TIMEOUT ms non spawna nessun pacco, options.js
    // esclude questa tile e l'agente si sposta su una nuova.
    currentSpawnTile: null,   // { x, y } della spawn tile corrente
    spawnArrivalTime: null,   // Date.now() quando ci siamo arrivati
};

export function updateConfig(config) {
    beliefs.config = config;
}

export function updateMap(width, height, tiles) {
    // --- 1. Costruisce mapTiles e deliveryPoints ---
    const ARROW_TYPES = new Set(['→', '←', '↑', '↓']);
    for (const tile of tiles) {
        const key = `${tile.x}_${tile.y}`;
        beliefs.mapTiles.set(key, { type: String(tile.type) });
        if (tile.type == '2') beliefs.deliveryPoints.push({ x: tile.x, y: tile.y });   
        if (ARROW_TYPES.has(tile.type)) beliefs.isDirectionalMap = true;
        console.log(`[BELIEFS] isDirectionalMap = ${beliefs.isDirectionalMap}`);
        
    }

    // --- 2. Precalcola spawnVisibility ---
    const obsDist = beliefs.config.GAME?.player?.observation_distance ?? 5;

    for (const [key, tile] of beliefs.mapTiles.entries()) {
        if (tile.type != '1') continue;

        const [x, y] = key.split('_').map(Number);
        let count = 0;

        for (const [k2, t2] of beliefs.mapTiles.entries()) {
            if (t2.type != '1') continue;
            const [sx, sy] = k2.split('_').map(Number);
            if (Math.abs(sx - x) + Math.abs(sy - y) < obsDist) count++;
        }

        beliefs.spawnVisibility.set(key, count);
        console.log(`[BELIEFS] spawnVisibility (${x},${y}) = ${count}`);
    }

    console.log(`[BELIEFS] spawnVisibility calcolata per ${beliefs.spawnVisibility.size} spawn tiles`);
}

export function updateSensing(sensing) {
    beliefs.parcels.clear();
    for (const p of sensing.parcels) {
        if (!p.carriedBy || p.carriedBy === beliefs.me.id) {
            beliefs.parcels.set(p.id, {
                id: p.id, x: p.x, y: p.y,
                reward: p.reward, carriedBy: p.carriedBy ?? null
            });
        }
    }
    console.log(`[updateSensing] parcels visibili:`, beliefs.parcels.size);
    // console.log(`[updateSensing] parcels:`, [...beliefs.parcels.values()]);

    const mine = sensing.parcels.filter(p => p.carriedBy === beliefs.me.id);
    beliefs.carrying       = mine.length > 0;
    beliefs.carriedParcels = mine;
    // console.log(`[updateSensing] carrying:`, beliefs.carrying);
    console.log(`[updateSensing] carriedParcels:`, beliefs.carriedParcels);

    updateAgents(sensing.agents ?? []);
}

export function updateAgents(agents) {
    beliefs.agents.clear();

    for (const a of agents) {
        if (a.x == null || a.y == null) continue;

        const fracX = a.x % 1;
        const fracY = a.y % 1;
        const moving = fracX !== 0 || fracY !== 0;

        let direction = 'none';
        let targetX   = Math.round(a.x);
        let targetY   = Math.round(a.y);

        if (moving) {
            if (fracX > 0.5)       { direction = 'right'; targetX = Math.floor(a.x) + 1; }
            else if (fracX > 0)    { direction = 'left';  targetX = Math.floor(a.x);     }
            else if (fracY > 0.5)  { direction = 'up';    targetY = Math.floor(a.y) + 1; }
            else if (fracY > 0)    { direction = 'down';  targetY = Math.floor(a.y);     }
        }

        beliefs.agents.set(a.id, {
            x: a.x, y: a.y,
            moving, direction,
            targetX, targetY,
        });

        console.log(`[updateAgents] "${a.name}" (${a.id}) @ (${a.x},${a.y}) moving:${moving} dir:${direction} → target:(${targetX},${targetY})`);
    }

    console.log(`[updateAgents] agenti tracciati:`, beliefs.agents.size);
}

export function getBlockedCells() {
    const blocked = new Set();
    for (const a of beliefs.agents.values()) {
        blocked.add(`${Math.round(a.x)}_${Math.round(a.y)}`);
        blocked.add(`${a.targetX}_${a.targetY}`);
    }
    console.log(`[getBlockedCells] celle bloccate:`, blocked.size);
    return blocked;
}

export function getAgentPositions() {
    const out = [];
    for (const a of beliefs.agents.values()) {
        out.push({ x: Math.round(a.x), y: Math.round(a.y) });
        if (a.moving) out.push({ x: a.targetX, y: a.targetY });
    }
    console.log(`[getAgentPositions] posizioni note:`, out);
    return out;
}
