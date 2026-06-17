// plans.js — Piani per mappe NORMALI (senza casse).
// Per mappe con casse (isCrateMap) vedere crates/plans_crate.js.
// Per i piani di coordinamento di team vedere ../channel/plans_channel.js.
//
// La planLibrary finale unisce tutti e tre i file: i piani crate vengono
// messi PRIMA così hanno priorità (isApplicableTo controlla isCrateMap).

import { beliefs, deliverableIds } from './beliefs.js';
import { navigateTo } from './moves.js';
import { planLibraryCrate } from './crates/plans_crate.js';
import { PlanBase } from './plan_base.js';
import { planLibraryChannel } from '../channel/plans_channel.js';


// ─────────────────────────────────────────────────────────────────────────────
// GoPickUp — raccolta pacco su mappa normale (sempre A*)
// ─────────────────────────────────────────────────────────────────────────────

export class GoPickUp extends PlanBase {
    #socket;
    constructor(socket) { super(); this.#socket = socket; }
    static isApplicableTo(action) { return action === 'go_pick_up' && !beliefs.isCrateMap; }

    async execute(_action, x, y, id) {
        if (this.stopped) throw ['stopped'];

        const parcel = beliefs.parcels.get(id);
        if (!parcel || parcel.carriedBy) throw [`Pacco ${id} non disponibile`];

        console.log(`[PLANS] GoPickUp A* → (${x},${y})`);
        const nav = await navigateTo(beliefs.me, { x, y }, this.#socket, beliefs.mapTiles, this.shouldStop);
        if (nav === 'stopped') throw ['stopped'];
        if (nav === 'failed')  throw [`Navigazione fallita verso (${x},${y})`];
        if (this.stopped)      throw ['stopped'];

        if (beliefs.carriedParcels.some(p => p.id === id)) return true;

        const freshParcel = beliefs.parcels.get(id);
        if (!freshParcel || freshParcel.carriedBy) throw [`Pacco ${id} sparito`];

        const picked = await this.#socket.emitPickup();
        if (!picked || picked.length === 0) throw [`Pickup vuoto in (${x},${y})`];
        beliefs.carrying       = true;
        beliefs.carriedParcels = [...beliefs.carriedParcels, ...picked];
        return true;
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// Deliver — consegna pacco su mappa normale
// ─────────────────────────────────────────────────────────────────────────────

export class Deliver extends PlanBase {
    #socket;
    constructor(socket) { super(); this.#socket = socket; }
    static isApplicableTo(action) { return action === 'deliver' && !beliefs.isCrateMap; }

    async execute(_action, x, y) {
        if (this.stopped) throw ['stopped'];
        if (!beliefs.carrying && beliefs.carriedParcels.length === 0)
            throw ['Deliver chiamato senza pacchi'];

        console.log(`[PLANS] Deliver A* → (${x},${y})`);
        const nav = await navigateTo(beliefs.me, { x, y }, this.#socket, beliefs.mapTiles, this.shouldStop);
        if (nav === 'stopped') throw ['stopped'];
        if (nav === 'failed')  throw [`Navigazione fallita verso (${x},${y})`];
        if (this.stopped)      throw ['stopped'];

        // Consegna SELETTIVA secondo le regole attive (max_deliver_reward,
        // stack_size). Senza regole -> tutti i pacchi.
        const ids = deliverableIds(beliefs);
        if (ids.length === 0) return true;   // nulla di consegnabile (es. tutti > soglia)

        const dropped = await this.#socket.emitPutdown(ids);
        const set = new Set(ids);
        beliefs.carriedParcels = beliefs.carriedParcels.filter(p => !set.has(p.id));
        beliefs.carrying       = beliefs.carriedParcels.length > 0;
        console.log(`[PLANS] Depositati ${dropped?.length ?? '?'} pacchi (restano ${beliefs.carriedParcels.length}). Score: ${beliefs.me.score}`);
        return true;
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// GoToSpawn — raggiunge una spawn tile su mappa normale
// ─────────────────────────────────────────────────────────────────────────────

export class GoToSpawn extends PlanBase {
    #socket;
    constructor(socket) { super(); this.#socket = socket; }
    static isApplicableTo(action) { return action === 'go_to_spawn' && !beliefs.isCrateMap; }

    async execute(_action, x, y) {
        if (this.stopped) throw ['stopped'];

        if (x == null || y == null) {
            await new Promise(r => setTimeout(r, 300));
            return true;
        }

        console.log(`[PLANS] GoToSpawn A* → (${x},${y})`);
        const nav = await navigateTo(beliefs.me, { x, y }, this.#socket, beliefs.mapTiles, this.shouldStop);

        if (nav === 'stopped') throw ['stopped'];
        if (nav === 'failed')  throw [`Navigazione fallita verso (${x},${y})`];

        await new Promise(r => setTimeout(r, 300));
        return true;
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// planLibrary — piani crate PRIMA (hanno isApplicableTo con isCrateMap),
//               poi piani normali, infine i piani di coordinamento di team.
// ─────────────────────────────────────────────────────────────────────────────

export const planLibrary = [
    ...planLibraryCrate,   // GoPickUpCrate, DeliverCrate, GoToSpawnCrate
    GoPickUp, Deliver, GoToSpawn,
    ...planLibraryChannel, // GoNearAndWait, GoToRowAndWait, RelayDrop, RelayFetch
];
