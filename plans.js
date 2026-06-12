// plans.js — Piani eseguibili. Il socket viene passato nel costruttore.
import { beliefs } from './beliefs.js';
import { navigateTo } from './moves.js';
import { smartDist } from './basic_functions.js';
import { getPddlPlan, planToMoves } from './pddl_planner.js';

class PlanBase {
    #stopped = false;
    get stopped()    { return this.#stopped; }
    get shouldStop() { return () => this.#stopped; }
    stop()           { this.#stopped = true; }
}

// Log dei piani BDI: silenziosi di default (il BDI è collaudato, i log utili
// sono quelli delle missioni). Riattivabili con LOG_BDI=true nel .env.
const LOG_BDI = process.env.LOG_BDI === 'true';
const logBdi  = (...a) => { if (LOG_BDI) console.log(...a); };

export class GoPickUp extends PlanBase {
    #socket;
    constructor(socket) { super(); this.#socket = socket; }
    static isApplicableTo(action) { return action === 'go_pick_up'; }

    async execute(_action, x, y, id) {
        if (this.stopped) throw ['stopped'];

        const parcel = beliefs.parcels.get(id);
        if (!parcel || parcel.carriedBy) throw [`Pacco ${id} non disponibile`];

        logBdi(`[PLANS] GoPickUp → (${x},${y})`);
        const nav = await navigateTo(beliefs.me, {x, y}, this.#socket, beliefs.mapTiles, this.shouldStop);
        if (nav === 'stopped') throw ['stopped'];
        if (nav === 'failed')  throw [`Navigazione fallita verso (${x},${y})`];
        if (this.stopped) throw ['stopped'];
        // Potrebbe essere già stato raccolto opportunisticamente durante il tragitto
        if (beliefs.carriedParcels.some(p => p.id === id)) {
            // console.log(`[PLANS] Pacco ${id} già raccolto in transito`);
            return true;
        }

        const freshParcel = beliefs.parcels.get(id);
        if (!freshParcel || freshParcel.carriedBy) throw [`Pacco ${id} sparito durante la navigazione`];

        const picked = await this.#socket.emitPickup();
        logBdi(`[PLANS] - GoPickUp -> picked = ${picked}`)
        if (!picked || picked.length === 0) throw [`Pickup vuoto in (${x},${y})`];

        beliefs.carrying       = true;
        beliefs.carriedParcels = [...beliefs.carriedParcels, ...picked];

        // console.log(`[PLANS] Raccolti ${picked.length} pacchi`);
        return true;
    }
}
/*
export class GoPickUp extends PlanBase {
    #socket;
    constructor(socket) { super(); this.#socket = socket; }
    static isApplicableTo(action) { return action === 'go_pick_up'; }

    async execute(_action, x, y, id) {
        if (this.stopped) throw ['stopped'];

        const parcel = beliefs.parcels.get(id);
        if (!parcel || parcel.carriedBy) throw [`Pacco ${id} non disponibile`];

        // ── TENTATIVO PDDL ────────────────────────────────────────────────
        // getPddlPlan ritorna null se USE_PDDL=false o se il solver fallisce.
        // Passiamo gli agenti nemici come ostacoli (se li hai nei beliefs).
        const enemies = beliefs.agents ? [...beliefs.agents.values()] : [];
        const rawPlan = await getPddlPlan(beliefs.me, beliefs.mapTiles, beliefs.parcels, id, enemies);

        if (rawPlan) {
            // console.log(`[PLANS] GoPickUp PDDL → (${x},${y})`);
            const moves = planToMoves(rawPlan);
            let pddlOk = true;

            for (const move of moves) {
                if (this.stopped) throw ['stopped'];

                if (move === 'pickup') {
                    const picked = await this.#socket.emitPickup();
                    if (picked && picked.length > 0) {
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
                        // Passo rifiutato (nemico sulla tile) → abbandona PDDL, usa A*
                        // console.warn(`[PLANS] PDDL: passo '${move}' rifiutato — fallback A*`);
                        pddlOk = false;
                        break;
                    }
                }
            }

            // Se il piano PDDL è andato a buon fine fino in fondo, abbiamo finito.
            // (controlliamo se il pacco target è stato effettivamente raccolto)
            if (pddlOk) {
                if (beliefs.carriedParcels.some(p => p.id === id)) {
                    // console.log(`[PLANS] PDDL: pacco ${id} raccolto`);
                    return true;
                }
                // PDDL finito ma pacco non raccolto: prova un pickup finale
                const picked = await this.#socket.emitPickup();
                if (picked && picked.length > 0) {
                    beliefs.carrying       = true;
                    beliefs.carriedParcels = [...beliefs.carriedParcels, ...picked];
                    return true;
                }
            }
            // Altrimenti cadiamo nel ramo A* qui sotto.
        }

        // ── FALLBACK A* ───────────────────────────────────────────────────
        // Raggiunto se: USE_PDDL=false, solver in timeout, o passo PDDL rifiutato.
        // console.log(`[PLANS] GoPickUp A* → (${x},${y})`);
        const nav = await navigateTo(beliefs.me, {x, y}, this.#socket, beliefs.mapTiles, this.shouldStop);
        if (nav === 'stopped') throw ['stopped'];
        if (nav === 'failed')  throw [`Navigazione fallita verso (${x},${y})`];
        if (this.stopped) throw ['stopped'];

        // Potrebbe essere già stato raccolto opportunisticamente durante il tragitto
        if (beliefs.carriedParcels.some(p => p.id === id)) {
            // console.log(`[PLANS] Pacco ${id} già raccolto in transito`);
            return true;
        }

        const freshParcel = beliefs.parcels.get(id);
        if (!freshParcel || freshParcel.carriedBy) throw [`Pacco ${id} sparito durante la navigazione`];

        const picked = await this.#socket.emitPickup();
        // console.log(`[PLANS] - GoPickUp -> picked = ${picked}`);
        if (!picked || picked.length === 0) throw [`Pickup vuoto in (${x},${y})`];

        beliefs.carrying       = true;
        beliefs.carriedParcels = [...beliefs.carriedParcels, ...picked];

        // console.log(`[PLANS] Raccolti ${picked.length} pacchi`);
        return true;
    }
}
*/
export class Deliver extends PlanBase {
    #socket;
    constructor(socket) { super(); this.#socket = socket; }
    static isApplicableTo(action) { return action === 'deliver'; }

    async execute(_action, x, y) {
        if (this.stopped) throw ['stopped'];

        if (!beliefs.carrying && beliefs.carriedParcels.length === 0)
            throw ['Deliver chiamato senza pacchi da consegnare'];

        // console.log(`[PLANS] Deliver → (${x},${y})`);
        const nav = await navigateTo(beliefs.me, {x, y}, this.#socket, beliefs.mapTiles, this.shouldStop);
        if (nav === 'stopped') throw ['stopped'];
        if (nav === 'failed')  throw [`Navigazione fallita verso (${x},${y})`];
        if (this.stopped) throw ['stopped'];

        const ids     = beliefs.carriedParcels.map(p => p.id);
        const dropped = await this.#socket.emitPutdown(ids.length > 0 ? ids : undefined);

        beliefs.carrying       = false;
        beliefs.carriedParcels = [];
        logBdi(`[PLANS] Depositati ${dropped?.length ?? '?'} pacchi. Score: ${beliefs.me.score}`);
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

        logBdi(`[PLANS] GoToSpawn → (${x},${y})`);
        const nav = await navigateTo(
            beliefs.me, { x, y }, this.#socket, beliefs.mapTiles, this.shouldStop
        );

        if (nav === 'stopped') {
            logBdi(`[PLANS] GoToSpawn INTERROTTO verso (${x},${y}) — ora @ (${Math.round(beliefs.me.x)},${Math.round(beliefs.me.y)})`);
            throw ['stopped'];
        }
        if (nav === 'failed')  throw [`Navigazione fallita verso (${x},${y})`];

        await new Promise(r => setTimeout(r, 300));
        return true;
    }
}

export const planLibrary = [GoPickUp, Deliver, GoToSpawn];
