// plans.js — Piani eseguibili. Il socket viene passato nel costruttore.

import { beliefs } from './beliefs.js';
import { navigateTo, exploreRandomStep } from './moves.js';

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

        // emitPickup() → [{id, x, y, carriedBy, reward}, ...]
        const picked = await this.#socket.emitPickup();
        if (!picked || picked.length === 0) throw [`Pickup vuoto in (${x},${y})`];

        beliefs.carrying       = true;
        beliefs.carriedParcels = picked;
        console.log(`[PLANS] Raccolti ${picked.length} pacchi`);
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

        // emitPutdown(ids?) → passa gli id o undefined per depositare tutto
        const ids     = beliefs.carriedParcels.map(p => p.id);
        const dropped = await this.#socket.emitPutdown(ids.length > 0 ? ids : undefined);

        beliefs.carrying       = false;
        beliefs.carriedParcels = [];
        console.log(`[PLANS] Depositati ${dropped?.length ?? '?'} pacchi. Score: ${beliefs.me.score}`);
        return true;
    }
}

export class Explore extends PlanBase {
    #socket;
    constructor(socket) { super(); this.#socket = socket; }
    static isApplicableTo(action) { return action === 'explore'; }

    async execute() {
        if (this.stopped) throw ['stopped'];
        await exploreRandomStep(this.#socket, beliefs.me);
        return true;
    }
}

// Libreria piani: ordine = priorità di applicazione
export const planLibrary = [GoPickUp, Deliver, Explore];
