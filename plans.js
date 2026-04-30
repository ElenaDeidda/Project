import { beliefs } from './beliefs.js';
import { navigateTo } from './moves.js'; // NON importiamo più exploreRandomStep

class PlanBase {
    #stopped = false;
    get stopped()    { return this.#stopped; }
    get shouldStop() { return () => this.#stopped; }
    stop()           { this.#stopped = true; }
}

export class GoPickUp extends PlanBase {
    #socket;
    constructor(socket) { super(); this.#socket = socket; }
    static isApplicableTo(action) { return action === 'go_pick_up'; }

    async execute(action, x, y, id) {
        if (this.stopped) throw ['stopped'];
        const parcel = beliefs.parcels.get(id);
        if (!parcel || parcel.carriedBy) throw [`Pacco ${id} non disponibile`];

        console.log(`[PLANS] GoPickUp → (${x},${y})`);
        const nav = await navigateTo(beliefs.me, {x, y}, this.#socket, beliefs.mapTiles, this.shouldStop);
        if (nav === 'stopped') throw ['stopped'];
        if (nav === 'failed')  throw [`Navigazione fallita verso (${x},${y})`];
        if (this.stopped) throw ['stopped'];

        const picked = await this.#socket.emitPickup();
        if (!picked || picked.length === 0) throw [`Pickup vuoto in (${x},${y})`];

        beliefs.carrying       = true;
        beliefs.carriedParcels = picked;
        return true;
    }
}

export class Deliver extends PlanBase {
    #socket;
    constructor(socket) { super(); this.#socket = socket; }
    static isApplicableTo(action) { return action === 'deliver'; }

    async execute(action, x, y) {
        if (this.stopped) throw ['stopped'];

        console.log(`[PLANS] Deliver → (${x},${y})`);
        const nav = await navigateTo(beliefs.me, {x, y}, this.#socket, beliefs.mapTiles, this.shouldStop);
        if (nav === 'stopped') throw ['stopped'];
        if (nav === 'failed')  throw [`Navigazione fallita verso (${x},${y})`];
        if (this.stopped) throw ['stopped'];

        const ids     = beliefs.carriedParcels.map(p => p.id);
        const dropped = await this.#socket.emitPutdown(ids.length > 0 ? ids : undefined);

        beliefs.carrying       = false;
        beliefs.carriedParcels = [];
        return true;
    }
}

// NUOVO PIANO: Pattugliamento intelligente delle zone di spawn
export class PatrolSpawn extends PlanBase {
    #socket;
    constructor(socket) { super(); this.#socket = socket; }
    static isApplicableTo(action) { return action === 'patrol_spawn'; }

    async execute() {
        if (this.stopped) throw ['stopped'];

        if (beliefs.spawnPoints.length === 0) {
            await new Promise(r => setTimeout(r, 200));
            return true;
        }

        // Filtra gli spawn points per non scegliere la casella su cui siamo già
        let availableSpawns = beliefs.spawnPoints.filter(sp => 
            sp.x !== Math.round(beliefs.me.x) || sp.y !== Math.round(beliefs.me.y)
        );
        
        // Se c'è solo uno spawn point in tutta la mappa e ci siamo sopra, usiamo quello
        if (availableSpawns.length === 0) availableSpawns = beliefs.spawnPoints;

        // Ne scegliamo uno a caso tra quelli disponibili
        const target = availableSpawns[Math.floor(Math.random() * availableSpawns.length)];

        console.log(`[PLANS] PatrolSpawn → ispeziono la zona verde in (${target.x},${target.y})`);
        
        const nav = await navigateTo(beliefs.me, target, this.#socket, beliefs.mapTiles, this.shouldStop);
        if (nav === 'stopped') throw ['stopped'];
        
        // Aspettiamo 2000ms quando arriviamo sul posto per vedere se compare un pacco
        await new Promise(r => setTimeout(r, 2000));
        return true;
    }
}

export class Wait extends PlanBase {
    constructor() { super(); }
    static isApplicableTo(action) { return action === 'wait'; }
    async execute() {
        if (this.stopped) throw ['stopped'];
        await new Promise(resolve => setTimeout(resolve, 200));
        return true;
    }
}

export const planLibrary = [GoPickUp, Deliver, PatrolSpawn, Wait];