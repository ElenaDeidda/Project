// beliefs.js — Stato del mondo e funzioni di aggiornamento
import { smartDist } from './basic_functions.js';

export const beliefs = {
    me:            { id: '', name: '', x: 0, y: 0, score: 0 },
    config:        {},
    mapTiles:      new Map(),
    deliveryPoints:[],
    parcels:       new Map(),
    agents:        new Map(),   // id → { x, y, moving, direction, targetX, targetY }
    carrying:      false,
    carriedParcels:[],
};

export function updateConfig(config) {
    beliefs.config = config;
}

export function updateMap(width, height, tiles) {
    for (const tile of tiles) {
        const key = `${tile.x}_${tile.y}`;
        beliefs.mapTiles.set(key, { type: tile.type });
       if (tile.type == '2') {
            console.log("[BELIEFS] ****************");

            beliefs.deliveryPoints.push({ x: tile.x, y: tile.y });
       }

    }
}

export function updateSensing(sensing) {
    beliefs.parcels.clear();
    for (const p of sensing.parcels) {
        if (!p.carriedBy || p.carriedBy === beliefs.me.id) {
            // Evitiamo di inserire nei beliefs i pacchi portati da altri agenti,
            // di cui non conosciamo la posizione esatta.
            beliefs.parcels.set(p.id, {
                id: p.id, x: p.x, y: p.y,
                reward: p.reward, carriedBy: p.carriedBy ?? null
            });
        }
    }
    console.log(`[updateSensing] parcels visibili:`, beliefs.parcels.size);
    console.log(`[updateSensing] parcels:`, [...beliefs.parcels.values()]);

    const mine = sensing.parcels.filter(p => p.carriedBy === beliefs.me.id);
    beliefs.carrying       = mine.length > 0;
    beliefs.carriedParcels = mine;
    console.log(`[updateSensing] carrying:`, beliefs.carrying);
    console.log(`[updateSensing] carriedParcels:`, beliefs.carriedParcels);

    // Aggiorna la mappa degli agenti avversari visibili
    updateAgents(sensing.agents ?? []);
}

/**
 * Aggiorna beliefs.agents con lo stato corrente degli agenti visibili.
 *
 * Sfrutta la meccanica del server: quando un agente si sposta da (x,y)
 * a una cella adiacente, il server manda prima x±0.6 (in transito) e poi
 * x±1.0 (arrivato). Dalla parte decimale deduciamo direzione e cella target
 * senza bisogno di storia.
 *
 * Struttura salvata per ogni agente:
 *   { x, y, moving, direction, targetX, targetY }
 *
 *   - moving:    true se x o y non è intero (agente in transito tra due tile)
 *   - direction: 'right'|'left'|'up'|'down'|'none'
 *   - targetX/Y: cella intera verso cui sta andando (= arrotondata se fermo)
 *
 * @param {Array} agents  sensing.agents dal server
 */
export function updateAgents(agents) {
    beliefs.agents.clear();

    for (const a of agents) {
        // x/y possono essere undefined se il server non li manda (caso raro)
        if (a.x == null || a.y == null) continue;

        const fracX = a.x % 1;
        const fracY = a.y % 1;
        const moving = fracX !== 0 || fracY !== 0;

        let direction = 'none';
        let targetX   = Math.round(a.x);
        let targetY   = Math.round(a.y);

        if (moving) {
            // Il server usa 0.6 per il primo step e 0.4 per il completamento.
            // fracX > 0.5  → si sta spostando verso destra  (es. 3.6 → target 4)
            // fracX tra 0 e 0.5 → stava andando a sinistra (es. 3.4 → target 3)
            // Stesso ragionamento per Y (up = y crescente, down = y decrescente).
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

/**
 * Restituisce un Set di chiavi "x_y" delle celle attualmente bloccate
 * dagli agenti avversari: sia la cella in cui si trovano ora,
 * sia quella verso cui stanno andando.
 *
 * Usato da aStarPath in moves.js per escludere queste celle dal percorso.
 *
 * @returns {Set<string>}
 */
export function getBlockedCells() {
    const blocked = new Set();
    for (const a of beliefs.agents.values()) {
        blocked.add(`${Math.round(a.x)}_${Math.round(a.y)}`); // cella corrente (arrotondata)
        blocked.add(`${a.targetX}_${a.targetY}`);              // cella di destinazione
    }
    console.log(`[getBlockedCells] celle bloccate:`, blocked.size);
    return blocked;
}

/**
 * Restituisce un array di posizioni {x, y} degli agenti avversari noti
 * (posizione intera corrente + target se in movimento).
 *
 * Usato da scoreParcel in options.js per penalizzare i pacchi
 * vicini ad agenti avversari.
 *
 * @returns {{x:number, y:number}[]}
 */
export function getAgentPositions() {
    const out = [];
    for (const a of beliefs.agents.values()) {
        out.push({ x: Math.round(a.x), y: Math.round(a.y) });
        if (a.moving) out.push({ x: a.targetX, y: a.targetY });
    }
    console.log(`[getAgentPositions] posizioni note:`, out);
    return out;
}