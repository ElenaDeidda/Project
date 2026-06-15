// plans.js — Piani per mappe NORMALI (senza casse).
// Per mappe con casse (isCrateMap) vedere plans_crate.js.
//
// La planLibrary finale unisce entrambi i file: i piani crate vengono
// messi PRIMA così hanno priorità (isApplicableTo controlla isCrateMap).

import { beliefs }    from './beliefs.js';
import { navigateTo } from './moves.js';
import { getPddlPlan, planToMoves } from './pddl_planner.js';
import { planLibraryCrate } from './plans_crate.js';

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
// GoPickUp — raccolta pacco su mappa normale (A* con fallback PDDL opzionale)
// ─────────────────────────────────────────────────────────────────────────────

export class GoPickUp extends PlanBase {
    #socket;
    constructor(socket) { super(); this.#socket = socket; }
    static isApplicableTo(action) { return action === 'go_pick_up'; }

    async execute(_action, x, y, id) {
        if (this.stopped) throw ['stopped'];

        const parcel = beliefs.parcels.get(id);
        if (!parcel || parcel.carriedBy) throw [`Pacco ${id} non disponibile`];

        // ── Tentativo PDDL (se abilitato) ───────────────────────────────────
        const enemies  = beliefs.agents ? [...beliefs.agents.values()] : [];
        const rawPlan  = await getPddlPlan(beliefs.me, beliefs.mapTiles, beliefs.parcels, id, enemies);

        if (rawPlan) {
            console.log(`[PLANS] GoPickUp PDDL → (${x},${y})`);
            const moves = planToMoves(rawPlan);
            let pddlOk  = true;

            for (const move of moves) {
                if (this.stopped) throw ['stopped'];

                if (move === 'pickup') {
                    const picked = await this.#socket.emitPickup();
                    if (picked?.length > 0) {
                        beliefs.carrying       = true;
                        beliefs.carriedParcels = [...beliefs.carriedParcels, ...picked];
                    }
                } else if (move === 'putdown') {
                    await this.#socket.emitPutdown();
                } else {
                    const result = await this.#socket.emitMove(move);
                    if (result?.x != null) {
                        beliefs.me.x = result.x;
                        beliefs.me.y = result.y;
                    } else {
                        pddlOk = false;
                        break;
                    }
                }
            }

            if (pddlOk) {
                if (beliefs.carriedParcels.some(p => p.id === id)) return true;
                const picked = await this.#socket.emitPickup();
                if (picked?.length > 0) {
                    beliefs.carrying       = true;
                    beliefs.carriedParcels = [...beliefs.carriedParcels, ...picked];
                    return true;
                }
            }
            // Piano PDDL interrotto → fallback A*
        }

        // ── Fallback A* ──────────────────────────────────────────────────────
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
    static isApplicableTo(action) { return action === 'deliver'; }

    async execute(_action, x, y) {
        if (this.stopped) throw ['stopped'];
        if (!beliefs.carrying && beliefs.carriedParcels.length === 0)
            throw ['Deliver chiamato senza pacchi'];

        console.log(`[PLANS] Deliver A* → (${x},${y})`);
        const nav = await navigateTo(beliefs.me, { x, y }, this.#socket, beliefs.mapTiles, this.shouldStop);
        if (nav === 'stopped') throw ['stopped'];
        if (nav === 'failed')  throw [`Navigazione fallita verso (${x},${y})`];
        if (this.stopped)      throw ['stopped'];

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
        console.log(`[PLANS] Depositati ${dropped?.length ?? '?'} pacchi${Number.isInteger(N) ? ` (stack di ${N})` : ''}. Score: ${beliefs.me.score}`);
        return true;
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// GoToSpawn — raggiunge una spawn tile su mappa normale
// ─────────────────────────────────────────────────────────────────────────────

export class GoToSpawn extends PlanBase {
    #socket;
    constructor(socket) { super(); this.#socket = socket; }
    static isApplicableTo(action) { return action === 'go_to_spawn'; }

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
// planLibrary — piani crate PRIMA (hanno isApplicableTo con isCrateMap)
//               poi piani normali come fallback
// ─────────────────────────────────────────────────────────────────────────────

export const planLibrary = [
    ...planLibraryCrate,   // GoPickUpCrate, DeliverCrate, GoToSpawnCrate
    GoPickUp,
    Deliver,
    GoToSpawn,
];