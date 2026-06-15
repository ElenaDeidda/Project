// plans_crate.js — Piani per mappe CON CASSE (isCrateMap === true).
//
// Questi piani vengono messi in testa alla planLibrary di plans.js,
// così hanno priorità su GoPickUp/Deliver/GoToSpawn normali.
// isApplicableTo controlla sempre `beliefs.isCrateMap` come guardia.
//
// Navigazione delegata a execCratePlan (pddl_creates.js) che:
//   1. chiama il solver PDDL per liberare il percorso dalle casse
//   2. esegue i push con emitMove diretto
//   3. usa A* per le mosse pure (move consecutivi)
//   4. se A* fallisce → ricalcola con il solver PDDL

import { beliefs }       from './beliefs.js';
import { execCratePlan } from './pddl_crates.js';


// ─────────────────────────────────────────────────────────────────────────────
// BASE
// ─────────────────────────────────────────────────────────────────────────────

class PlanBase {
    #stopped = false;
    get stopped()    { return this.#stopped; }
    get shouldStop() { return () => this.#stopped; }
    stop()           { this.#stopped = true; }
}


// ─────────────────────────────────────────────────────────────────────────────
// GoPickUpCrate — raggiunge e raccoglie un pacco su mappa con casse
// ─────────────────────────────────────────────────────────────────────────────

export class GoPickUpCrate extends PlanBase {
    #socket;
    constructor(socket) { super(); this.#socket = socket; }
    static isApplicableTo(action) { return action === 'go_pick_up' && beliefs.isCrateMap; }

    async execute(_action, x, y, id) {
        if (this.stopped) throw ['stopped'];

        const parcel = beliefs.parcels.get(id);
        if (!parcel || parcel.carriedBy) throw [`Pacco ${id} non disponibile`];

        console.log(`[CRATE_PLANS] GoPickUpCrate → (${x},${y})`);

        const arrived = await execCratePlan(beliefs, this.#socket, x, y, this.shouldStop);
        if (!arrived) throw [`PDDL/A* fallito per GoPickUpCrate → (${x},${y})`];
        if (this.stopped) throw ['stopped'];

        // Potrebbe essere già stato raccolto opportunisticamente in transito
        if (beliefs.carriedParcels.some(p => p.id === id)) return true;

        const freshParcel = beliefs.parcels.get(id);
        if (!freshParcel || freshParcel.carriedBy) throw [`Pacco ${id} sparito durante navigazione`];

        const picked = await this.#socket.emitPickup();
        if (!picked || picked.length === 0) throw [`Pickup vuoto in (${x},${y})`];

        beliefs.carrying       = true;
        beliefs.carriedParcels = [...beliefs.carriedParcels, ...picked];
        console.log(`[CRATE_PLANS] Raccolti ${picked.length} pacchi`);
        return true;
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// DeliverCrate — consegna pacchi su mappa con casse
// ─────────────────────────────────────────────────────────────────────────────

export class DeliverCrate extends PlanBase {
    #socket;
    constructor(socket) { super(); this.#socket = socket; }
    static isApplicableTo(action) { return action === 'deliver' && beliefs.isCrateMap; }

    async execute(_action, x, y) {
        if (this.stopped) throw ['stopped'];
        if (!beliefs.carrying && beliefs.carriedParcels.length === 0)
            throw ['DeliverCrate chiamato senza pacchi'];

        console.log(`[CRATE_PLANS] DeliverCrate → (${x},${y})`);

        const arrived = await execCratePlan(beliefs, this.#socket, x, y, this.shouldStop);
        if (!arrived) throw [`PDDL/A* fallito per DeliverCrate → (${x},${y})`];
        if (this.stopped) throw ['stopped'];

        const N = beliefs.activeRules?.stackSize;
        let ids;
        if (Number.isInteger(N) && beliefs.carriedParcels.length >= N) {
            ids = [...beliefs.carriedParcels]
                .sort((a, b) => (b.reward ?? 0) - (a.reward ?? 0))
                .slice(0, N)
                .map(p => p.id);
        } else {
            ids = beliefs.carriedParcels.map(p => p.id);
        }

        const dropped = await this.#socket.emitPutdown(ids.length > 0 ? ids : undefined);
        const set = new Set(ids);
        beliefs.carriedParcels = beliefs.carriedParcels.filter(p => !set.has(p.id));
        beliefs.carrying       = beliefs.carriedParcels.length > 0;
        console.log(`[CRATE_PLANS] Depositati ${dropped?.length ?? '?'} pacchi${Number.isInteger(N) ? ` (stack di ${N}, restano ${beliefs.carriedParcels.length})` : ''}. Score: ${beliefs.me.score}`);
        return true;
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// GoToSpawnCrate — raggiunge una spawn tile su mappa con casse
// ─────────────────────────────────────────────────────────────────────────────

export class GoToSpawnCrate extends PlanBase {
    #socket;
    constructor(socket) { super(); this.#socket = socket; }
    static isApplicableTo(action) { return action === 'go_to_spawn' && beliefs.isCrateMap; }

    async execute(_action, x, y) {
        if (this.stopped) throw ['stopped'];

        if (x == null || y == null) {
            await new Promise(r => setTimeout(r, 300));
            return true;
        }

        console.log(`[CRATE_PLANS] GoToSpawnCrate → (${x},${y})`);
        console.log(`[CRATE_PLANS] casse attive: ${[...beliefs.crateTiles.keys()].join(' ')}`);

        const arrived = await execCratePlan(beliefs, this.#socket, x, y, this.shouldStop);

        if (!arrived) {
            console.warn(`[CRATE_PLANS] GoToSpawnCrate: STALLO — nessun piano verso (${x},${y}). Attendo...`);
            await new Promise(r => setTimeout(r, 1000));
            return true;   // non throw: lo stallo è gestito aspettando
        }

        await new Promise(r => setTimeout(r, 300));
        return true;
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// Export della libreria parziale — importata da plans.js
// ─────────────────────────────────────────────────────────────────────────────

export const planLibraryCrate = [GoPickUpCrate, DeliverCrate, GoToSpawnCrate];