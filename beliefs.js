// beliefs.js — Stato del mondo e funzioni di aggiornamento
import { smartDist } from './basic_functions.js';

export const beliefs = {
    me:            { id: '', name: '', x: 0, y: 0, score: 0 },
    config:        {},
    mapTiles:      new Map(),
    deliveryPoints:[],
    parcels:       new Map(),
    agentHistory:  new Map(),
    carrying:      false,
    carriedParcels:[],
};

/* @type { Map< string, {id: string, carriedBy?: string, x:number, y:number, reward:number} > }*/
export function updateConfig(config) {
    beliefs.config = config;
}

export function updateMap(width, height, tiles) {
    for (const tile of tiles) {
        const key = `${tile.x}_${tile.y}`;
        beliefs.mapTiles.set(key, {type: tile.type });

        if (tile.type === '2') {
            beliefs.deliveryPoints.push({ x: tile.x, y: tile.y });
        }
    }
}

export function updateSensing(sensing) {
    beliefs.parcels.clear();
    for (const p of sensing.parcels) {
        if (!p.carriedBy || p.carriedBy === beliefs.me.id) {
            // con l'if evitiamo di inserire nei beliefs i pacchi che stanno portando gli altri agenti, di cui non conosciamo la posizione esatta
            beliefs.parcels.set(p.id, { id: p.id, x: p.x, y: p.y, reward: p.reward, carriedBy: p.carriedBy ?? null });
        }
    }
    console.log(`[updateSensing] parcels visibili:`, beliefs.parcels.size);
    console.log(`[updateSensing] parcels:`, [...beliefs.parcels.values()]);

    const mine = sensing.parcels.filter(p => p.carriedBy === beliefs.me.id);
    beliefs.carrying       = mine.length > 0;
    beliefs.carriedParcels = mine;
    console.log(`[updateSensing] carrying:`, beliefs.carrying);
    console.log(`[updateSensing] carriedParcels:`, beliefs.carriedParcels);
}

/*function _updateAgentHistory(agents) {
    const now     = Date.now();
    const obsDist = beliefs.config?.GAME?.player?.observation_distance ?? 5;
    const seenIds = new Set(agents.map(a => a.id));

    for (const a of agents) {
        //continue salta alla prossima iterazione del ciclo, mentre break esce completamente dal ciclo. 
        // Qui usiamo continue perché vogliamo semplicemente ignorare gli agenti in movimento e non aggiungerli alla storia,
        //  ma continuare a processare gli altri agenti visibili. 
        if (isMoving(a)) continue;
        //Caso A - Nuovo agente visto per la prima volta: lo aggiungo alla storia
        if (!beliefs.agentHistory.has(a.id)) {
            beliefs.agentHistory.set(a.id, [{ name: a.name, x: a.x, y: a.y, timestamp: now, direction: 'none' }]);
            console.log(`[agentHistory] NUOVO agente "${a.name}" (${a.id}) @ (${a.x},${a.y})`);
            // Se l'agente è molto vicino ma non è stato visto prima, potrebbe essere un agente già noto che è entrato nel raggio di osservazione dopo essere stato lost. In questo caso, lo tracciamo comunque, ma con una nota speciale.
        } else {
            const history = beliefs.agentHistory.get(a.id);
            const last    = history[history.length - 1];
            const prev    = typeof last === 'object' ? last : _findLastKnownPos(history);
            let dir = 'none';
            // Caso B - Agente già visto: se si è mosso, aggiorno la storia con la nuova posizione e direzione
            if (prev) {
                if (prev.x < a.x) dir = 'right';
                else if (prev.x > a.x) dir = 'left';
                else if (prev.y < a.y) dir = 'up';
                else if (prev.y > a.y) dir = 'down';
            }
            // Se la posizione è cambiata, aggiungo un nuovo record; altrimenti, aggiorno il timestamp dell'ultimo record
            if (typeof last === 'object') {
                // Se l'agente era fermo e ora è in movimento, o viceversa, o se è cambiata la posizione, aggiungo un nuovo record
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
        const last = history[history.length - 1];
        const lastKnown = _findLastKnownPos(history);
        if (typeof last === 'object') {
            history.push('lost');
            console.log(`[agentHistory] LOST agente (${id}), ultima pos: (${lastKnown?.x},${lastKnown?.y}) — probabilmente in movimento`);
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
*/

export function getKnownAgentPositions() {
    const out = [];
    for (const history of beliefs.agentHistory.values()) {
        const last = history[history.length - 1];
        if (typeof last === 'object') out.push({ x: last.x, y: last.y });
    }
    console.log(`[getKnownAgentPositions] posizioni note:`, out);
    return out;
}