// plans.js — Piani eseguibili. Il socket viene passato nel costruttore.
import { beliefs } from './beliefs.js';
import { navigateTo } from './moves.js';
import { smartDist } from './basic_functions.js';
import { getPddlPlan, planToMoves } from './pddl_planner.js';
import { solveCratePath, planToMoveSequence } from './pddl_creates.js';

class PlanBase {
    #stopped = false;
    get stopped()    { return this.#stopped; }
    get shouldStop() { return () => this.#stopped; }
    stop()           { this.#stopped = true; }
}

export class GoPickUpCrate extends PlanBase {
    #socket;
    constructor(socket) { super(); this.#socket = socket; }
    static isApplicableTo(action) { return action === 'go_pick_up' && beliefs.isCrateMap; }

    async execute(_action, x, y, id) {
        if (this.stopped) throw ['stopped'];

        const parcel = beliefs.parcels.get(id);
        if (!parcel || parcel.carriedBy) throw [`Pacco ${id} non disponibile`];

        console.log(`[PLANS] GoPickUpCrate PDDL → (${x},${y})`);
        const planSteps = await solveCratePath(beliefs, x, y);
        if (!planSteps) throw [`PDDL solver fallito per crate map → (${x},${y})`];

        const moves = planToMoveSequence(planSteps);

        for (const step of moves) {
            if (this.stopped) throw ['stopped'];
            const result = await this.#socket.emitMove(step.direction);
            if (result?.x != null) {
                beliefs.me.x = result.x;
                beliefs.me.y = result.y;
            } else {
                throw [`Mossa '${step.direction}' rifiutata durante esecuzione piano casse`];
            }
            if (step.isPush) {
                const fromKey = `${step.crateFrom.x}_${step.crateFrom.y}`;
                const toKey   = `${step.crateTo.x}_${step.crateTo.y}`;
                beliefs.crateTiles.delete(fromKey);
                beliefs.crateTiles.set(toKey, step.crateTo);
                beliefs.mapTiles.set(fromKey, { type: '5' });
                beliefs.mapTiles.set(toKey,   { type: '5!' });
            }
        }

        if (beliefs.carriedParcels.some(p => p.id === id)) return true;

        const picked = await this.#socket.emitPickup();
        if (!picked || picked.length === 0) throw [`Pickup vuoto in (${x},${y})`];
        beliefs.carrying       = true;
        beliefs.carriedParcels = [...beliefs.carriedParcels, ...picked];
        return true;
    }
}

export class DeliverCrate extends PlanBase {
    #socket;
    constructor(socket) { super(); this.#socket = socket; }
    static isApplicableTo(action) { return action === 'deliver' && beliefs.isCrateMap; }

    async execute(_action, x, y) {
        if (this.stopped) throw ['stopped'];
        if (!beliefs.carrying && beliefs.carriedParcels.length === 0)
            throw ['DeliverCrate chiamato senza pacchi'];

        console.log(`[PLANS] DeliverCrate PDDL → (${x},${y})`);
        const planSteps = await solveCratePath(beliefs, x, y);
        if (!planSteps) throw [`PDDL solver fallito per delivery su crate map → (${x},${y})`];

        const moves = planToMoveSequence(planSteps);

        for (const step of moves) {
            if (this.stopped) throw ['stopped'];
            const result = await this.#socket.emitMove(step.direction);
            if (result?.x != null) {
                beliefs.me.x = result.x;
                beliefs.me.y = result.y;
            } else {
                throw [`Mossa '${step.direction}' rifiutata`];
            }
            if (step.isPush) {
                const fromKey = `${step.crateFrom.x}_${step.crateFrom.y}`;
                const toKey   = `${step.crateTo.x}_${step.crateTo.y}`;
                beliefs.crateTiles.delete(fromKey);
                beliefs.crateTiles.set(toKey, step.crateTo);
                beliefs.mapTiles.set(fromKey, { type: '5' });
                beliefs.mapTiles.set(toKey,   { type: '5!' });
            }
        }

        const N = beliefs.activeRules?.stackSize;
        let ids;
        if (Number.isInteger(N) && beliefs.carriedParcels.length >= N) {
            ids = [...beliefs.carriedParcels]
                .sort((a, b) => (b.reward ?? 0) - (a.reward ?? 0))
                .slice(0, N).map(p => p.id);
        } else {
            ids = beliefs.carriedParcels.map(p => p.id);
        }
        const dropped = await this.#socket.emitPutdown(ids.length > 0 ? ids : undefined);
        const set = new Set(ids);
        beliefs.carriedParcels = beliefs.carriedParcels.filter(p => !set.has(p.id));
        beliefs.carrying       = beliefs.carriedParcels.length > 0;
        console.log(`[PLANS] DeliverCrate: depositati ${dropped?.length ?? '?'} pacchi`);
        return true;
    }
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
        // Potrebbe essere già stato raccolto opportunisticamente durante il tragitto
        if (beliefs.carriedParcels.some(p => p.id === id)) {
            // console.log(`[PLANS] Pacco ${id} già raccolto in transito`);
            return true;
        }

        const freshParcel = beliefs.parcels.get(id);
        if (!freshParcel || freshParcel.carriedBy) throw [`Pacco ${id} sparito durante la navigazione`];

        const picked = await this.#socket.emitPickup();
        console.log(`[PLANS] - GoPickUp -> picked = ${picked}`)
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

        // stack_size: se ne porto ≥ N consegno ESATTAMENTE N (i più ricchi) e
        // tengo il resto per lo stack successivo; se ne porto < N consegno tutto
        // (fallback pragmatico: il BDI ha deciso di consegnare e non c'è di meglio).
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
        console.log(`[PLANS] Depositati ${dropped?.length ?? '?'} pacchi${Number.isInteger(N) ? ` (stack di ${N}, restano ${beliefs.carriedParcels.length})` : ''}. Score: ${beliefs.me.score}`);
        return true;
    }
}

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

        console.log(`[CRATE_DEBUG] casse: ${[...beliefs.crateTiles.keys()].join(' ')}`);
        const planSteps = await solveCratePath(beliefs, x, y);
        if (!planSteps) {
            console.warn(`[PLANS] GoToSpawnCrate: STALLO — nessun piano PDDL verso (${x},${y}). Casse bloccate.`);
            await new Promise(r => setTimeout(r, 1000));
            return true;
        }

        console.log(`[PLANS] GoToSpawnCrate PDDL → (${x},${y})`);
        const moves = planToMoveSequence(planSteps);

        for (const step of moves) {
            if (this.stopped) throw ['stopped'];
            const result = await this.#socket.emitMove(step.direction);
            if (result?.x != null) {
                beliefs.me.x = result.x;
                beliefs.me.y = result.y;
            } else {
                throw [`Mossa '${step.direction}' rifiutata`];
            }
            if (step.isPush) {
                const fromKey = `${step.crateFrom.x}_${step.crateFrom.y}`;
                const toKey   = `${step.crateTo.x}_${step.crateTo.y}`;
                beliefs.crateTiles.delete(fromKey);
                beliefs.crateTiles.set(toKey, step.crateTo);
                beliefs.mapTiles.set(fromKey, { type: '5' });
                beliefs.mapTiles.set(toKey,   { type: '5!' });
            }
        }

        await new Promise(r => setTimeout(r, 300));
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

        if (nav === 'stopped') {
            console.log(`[PLANS] GoToSpawn INTERROTTO verso (${x},${y}) — ora \@ (${Math.round(beliefs.me.x)},${Math.round(beliefs.me.y)})`);
            throw ['stopped'];
        }
        if (nav === 'failed')  throw [`Navigazione fallita verso (${x},${y})`];

        await new Promise(r => setTimeout(r, 300));
        return true;
    }
}

export const planLibrary = [GoPickUpCrate, DeliverCrate, GoToSpawnCrate, GoPickUp, Deliver, GoToSpawn];
