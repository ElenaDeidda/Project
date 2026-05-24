// plans.js — Piani eseguibili. Il socket viene passato nel costruttore.
import { beliefs } from './beliefs.js';
import { navigateTo } from './moves.js';
import { smartDist } from './basic_functions.js';

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

    async execute(_action, x, y, id) {
        if (this.stopped) throw ['stopped'];

        const parcel = beliefs.parcels.get(id);
        if (!parcel || parcel.carriedBy) throw [`Pacco ${id} non disponibile`];

        console.log(`[PLANS] GoPickUp → (${x},${y})`);
        const nav = await navigateTo(beliefs.me, {x, y}, this.#socket, beliefs.mapTiles, this.shouldStop);
        if (nav === 'stopped') throw ['stopped'];
        if (nav === 'failed')  throw [`Navigazione fallita verso (${x},${y})`];
        if (this.stopped) throw ['stopped'];

        const freshParcel = beliefs.parcels.get(id);
        if (!freshParcel || freshParcel.carriedBy) throw [`Pacco ${id} sparito durante la navigazione`];

        const picked = await this.#socket.emitPickup();
        if (!picked || picked.length === 0) throw [`Pickup vuoto in (${x},${y})`];

        beliefs.carrying       = true;
        beliefs.carriedParcels = [...beliefs.carriedParcels, ...picked];

        // Reset timeout spawn tile: non siamo più in attesa su una spawn tile
        beliefs.currentSpawnTile = null;
        beliefs.spawnArrivalTime = null;

        console.log(`[PLANS] Raccolti ${picked.length} pacchi`);
        return true;
    }
}

export class Deliver extends PlanBase {
    #socket;
    constructor(socket) { super(); this.#socket = socket; }
    static isApplicableTo(action) { return action === 'deliver'; }

    async execute(_action, x, y) {
        if (this.stopped) throw ['stopped'];

        if (!beliefs.carrying && beliefs.carriedParcels.length === 0)
            throw ['Deliver chiamato senza pacchi da consegnare'];

        console.log(`[PLANS] Deliver → (${x},${y})`);
        const nav = await navigateTo(beliefs.me, {x, y}, this.#socket, beliefs.mapTiles, this.shouldStop);
        if (nav === 'stopped') throw ['stopped'];
        if (nav === 'failed')  throw [`Navigazione fallita verso (${x},${y})`];
        if (this.stopped) throw ['stopped'];

        const ids     = beliefs.carriedParcels.map(p => p.id);
        const dropped = await this.#socket.emitPutdown(ids.length > 0 ? ids : undefined);

        beliefs.carrying       = false;
        beliefs.carriedParcels = [];
        console.log(`[PLANS] Depositati ${dropped?.length ?? '?'} pacchi. Score: ${beliefs.me.score}`);
        return true;
    }
}

export class GoToSpawn extends PlanBase {
    #socket;
    constructor(socket) { super(); this.#socket = socket; }
    static isApplicableTo(action) { return action === 'go_to_spawn'; }

    async execute(_action, x, y) {
        if (this.stopped) throw ['stopped'];

        // Fallback: tutte le spawn tile erano bloccate, aspetta fermo
        if (x == null || y == null) {
            await new Promise(r => setTimeout(r, 300));
            return true;
        }

        console.log(`[PLANS] GoToSpawn → (${x},${y})`);
        const nav = await navigateTo(
            beliefs.me, { x, y }, this.#socket, beliefs.mapTiles, this.shouldStop
        );

        if (nav === 'stopped') throw ['stopped'];
        if (nav === 'failed')  throw [`Navigazione fallita verso (${x},${y})`];

        // Aggiorna il timer SOLO se la tile è diversa da quella corrente.
        // Se il piano viene rieseguito sulla stessa tile (loop 200ms),
        // il timestamp rimane invariato e il timeout può scadere correttamente.
        if (!beliefs.currentSpawnTile ||
            beliefs.currentSpawnTile.x !== x ||
            beliefs.currentSpawnTile.y !== y) {
            beliefs.currentSpawnTile = { x, y };
            beliefs.spawnArrivalTime = Date.now();
            console.log(`[PLANS] GoToSpawn: nuova tile (${x},${y}), timeout tra 3s`);
        } else {
            console.log(`[PLANS] GoToSpawn: già su (${x},${y}), timer invariato`);
        }

        await new Promise(r => setTimeout(r, 300));
        return true;
    }
}

export const planLibrary = [GoPickUp, Deliver, GoToSpawn];
