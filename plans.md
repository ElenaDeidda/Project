// plans.js — Piani eseguibili. Il socket viene passato nel costruttore.
// CONTIENE FILE IN CUI TUTTE E TRE LE FUNZONI USANO IL PLANNER PDDL, CON FALLBACK A* SE IL PIANO FALLISCE DURANTE L'EXECUTE.
import { beliefs } from './beliefs.js';
import { navigateTo } from './moves.js';
import { smartDist } from './basic_functions.js';
import { getPddlPlan, getPddlPlanDeliver, getPddlPlanSpawn, planToMoves } from './pddl_planner.js';

class PlanBase {
    #stopped = false;
    get stopped()    { return this.#stopped; }
    get shouldStop() { return () => this.#stopped; }
    stop()           { this.#stopped = true; }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER interno: esegui una sequenza di mosse PDDL (solo navigazione, no pickup/putdown).
// Ritorna true se tutte le mosse sono andate bene, false se un passo è stato rifiutato.
// ─────────────────────────────────────────────────────────────────────────────
async function executePddlMoves(moves, socket, shouldStop) {
    for (const move of moves) {
        if (shouldStop()) return false;

        // Per Deliver e GoToSpawn il piano non contiene pickup/putdown,
        // ma lo gestiamo comunque per sicurezza.
        if (move === 'pickup' || move === 'putdown') continue;

        const result = await socket.emitMove(move);
        if (result?.x != null) {
            beliefs.me.x = result.x;
            beliefs.me.y = result.y;
        } else {
            // Passo rifiutato (es. nemico sulla tile) → fallback A*
            return false;
        }
    }
    return true;
}


// ─────────────────────────────────────────────────────────────────────────────
// GoPickUp
// ─────────────────────────────────────────────────────────────────────────────

export class GoPickUp extends PlanBase {
    #socket;
    constructor(socket) { super(); this.#socket = socket; }
    static isApplicableTo(action) { return action === 'go_pick_up'; }

    async execute(_action, x, y, id) {
        if (this.stopped) throw ['stopped'];

        const parcel = beliefs.parcels.get(id);
        if (!parcel || parcel.carriedBy) throw [`Pacco ${id} non disponibile`];

        // ── TENTATIVO PDDL ────────────────────────────────────────────────
        const enemies  = beliefs.agents ? [...beliefs.agents.values()] : [];
        const rawPlan  = await getPddlPlan(beliefs.me, beliefs.mapTiles, beliefs.parcels, id, enemies);

        if (rawPlan) {
            const moves  = planToMoves(rawPlan);
            let pddlOk   = true;

            for (const move of moves) {
                if (this.stopped) throw ['stopped'];

                if (move === 'pickup') {
                    const picked = await this.#socket.emitPickup();
                    if (picked && picked.length > 0) {
                        beliefs.carrying       = true;
                        beliefs.carriedParcels = [...beliefs.carriedParcels, ...picked];
                    }
                } else if (move === 'putdown') {
                    // Non dovrebbe esserci nel piano pickup, ma lo saltiamo per sicurezza
                    continue;
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
                // Arrivati ma pickup non nel piano: tenta finale
                const picked = await this.#socket.emitPickup();
                if (picked && picked.length > 0) {
                    beliefs.carrying       = true;
                    beliefs.carriedParcels = [...beliefs.carriedParcels, ...picked];
                    return true;
                }
            }
            // pddlOk=false → cade nel fallback A*
        }

        // ── FALLBACK A* ───────────────────────────────────────────────────
        const nav = await navigateTo(beliefs.me, {x, y}, this.#socket, beliefs.mapTiles, this.shouldStop);
        if (nav === 'stopped') throw ['stopped'];
        if (nav === 'failed')  throw [`Navigazione fallita verso (${x},${y})`];
        if (this.stopped) throw ['stopped'];

        if (beliefs.carriedParcels.some(p => p.id === id)) return true;

        const freshParcel = beliefs.parcels.get(id);
        if (!freshParcel || freshParcel.carriedBy) throw [`Pacco ${id} sparito durante la navigazione`];

        const picked = await this.#socket.emitPickup();
        if (!picked || picked.length === 0) throw [`Pickup vuoto in (${x},${y})`];

        beliefs.carrying       = true;
        beliefs.carriedParcels = [...beliefs.carriedParcels, ...picked];
        return true;
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// Deliver
// ─────────────────────────────────────────────────────────────────────────────

export class Deliver extends PlanBase {
    #socket;
    constructor(socket) { super(); this.#socket = socket; }
    static isApplicableTo(action) { return action === 'deliver'; }

    async execute(_action, x, y) {
        if (this.stopped) throw ['stopped'];

        if (!beliefs.carrying && beliefs.carriedParcels.length === 0)
            throw ['Deliver chiamato senza pacchi da consegnare'];

        // ── TENTATIVO PDDL ────────────────────────────────────────────────
        // Goal: (at agent1 t_X_Y) — il planner calcola solo il percorso.
        // Il putdown lo facciamo noi dopo l'arrivo, come nell'A*.
        const enemies = beliefs.agents ? [...beliefs.agents.values()] : [];
        const rawPlan = await getPddlPlanDeliver(beliefs.me, beliefs.mapTiles, x, y, enemies);

        if (rawPlan) {
            const moves  = planToMoves(rawPlan);
            const pddlOk = await executePddlMoves(moves, this.#socket, this.shouldStop);

            if (this.stopped) throw ['stopped'];

            if (pddlOk) {
                // Arrivati alla delivery tile via PDDL → fai il putdown
                const ids     = beliefs.carriedParcels.map(p => p.id);
                const dropped = await this.#socket.emitPutdown(ids.length > 0 ? ids : undefined);
                beliefs.carrying       = false;
                beliefs.carriedParcels = [];
                console.log(`[PLANS] Deliver PDDL — Depositati ${dropped?.length ?? '?'} pacchi. Score: ${beliefs.me.score}`);
                return true;
            }
            // pddlOk=false → cade nel fallback A*
        }

        // ── FALLBACK A* ───────────────────────────────────────────────────
        const nav = await navigateTo(beliefs.me, {x, y}, this.#socket, beliefs.mapTiles, this.shouldStop);
        if (nav === 'stopped') throw ['stopped'];
        if (nav === 'failed')  throw [`Navigazione fallita verso (${x},${y})`];
        if (this.stopped) throw ['stopped'];

        const ids     = beliefs.carriedParcels.map(p => p.id);
        const dropped = await this.#socket.emitPutdown(ids.length > 0 ? ids : undefined);
        beliefs.carrying       = false;
        beliefs.carriedParcels = [];
        console.log(`[PLANS] Deliver A* — Depositati ${dropped?.length ?? '?'} pacchi. Score: ${beliefs.me.score}`);
        return true;
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// GoToSpawn
// ─────────────────────────────────────────────────────────────────────────────

export class GoToSpawn extends PlanBase {
    #socket;
    constructor(socket) { super(); this.#socket = socket; }
    static isApplicableTo(action) { return action === 'go_to_spawn'; }

    async execute(_action, x, y) {
        if (this.stopped) throw ['stopped'];

        // Coordinate null → tutte le spawn bloccate, aspetta fermo
        if (x == null || y == null) {
            await new Promise(r => setTimeout(r, 300));
            return true;
        }

        // ── TENTATIVO PDDL ────────────────────────────────────────────────
        // Goal: (at agent1 t_X_Y) — percorso verso la spawn tile.
        const enemies = beliefs.agents ? [...beliefs.agents.values()] : [];
        const rawPlan = await getPddlPlanSpawn(beliefs.me, beliefs.mapTiles, x, y, enemies);

        if (rawPlan) {
            const moves  = planToMoves(rawPlan);
            const pddlOk = await executePddlMoves(moves, this.#socket, this.shouldStop);

            if (this.stopped) {
                console.log(`[PLANS] GoToSpawn PDDL INTERROTTO verso (${x},${y})`);
                throw ['stopped'];
            }

            if (pddlOk) {
                await new Promise(r => setTimeout(r, 300));
                return true;
            }
            // pddlOk=false → cade nel fallback A*
        }

        // ── FALLBACK A* ───────────────────────────────────────────────────
        console.log(`[PLANS] GoToSpawn A* → (${x},${y})`);
        const nav = await navigateTo(
            beliefs.me, { x, y }, this.#socket, beliefs.mapTiles, this.shouldStop
        );

        if (nav === 'stopped') {
            console.log(`[PLANS] GoToSpawn INTERROTTO verso (${x},${y}) — ora @ (${Math.round(beliefs.me.x)},${Math.round(beliefs.me.y)})`);
            throw ['stopped'];
        }
        if (nav === 'failed') throw [`Navigazione fallita verso (${x},${y})`];

        await new Promise(r => setTimeout(r, 300));
        return true;
    }
}

export const planLibrary = [GoPickUp, Deliver, GoToSpawn];
