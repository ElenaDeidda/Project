// plans.js — Piani eseguibili. Il socket viene passato nel costruttore.
import { beliefs } from './beliefs.js';
import { navigateTo } from './moves.js';  
import { smartDist } from './basic_functions.js';


/*options.js                  intentions.js              plans.js
──────────                  ─────────────              ────────
generateOptions()
deliberate()
  → ['go_pick_up',4,3,'p1'] ──push()──→ IntentionRevision
                                            │
                                        IntentionDeliberation.achieve()
                                            │ scorre planLibrary
                                            │ GoPickUp.isApplicableTo('go_pick_up') → true
                                            │
                                        new GoPickUp(socket)
                                        .execute('go_pick_up', 4, 3, 'p1')
                                            │
                                            ├─ navigateTo → moves.js
                                            ├─ emitPickup → server
                                            └─ return true
                                            
  → nuovo sensing → nuova delibera ──push()──→ ... */

/*
PlanBase          ← classe base condivisa (gestione stop)
  ├── GoPickUp    ← va al pacco e lo raccoglie
  ├── Deliver     ← va al delivery point e deposita
  └── WaitAtSpawn ← fallback (aspetta nel punto di spawn)

planLibrary       ← array esportato, usato da intentions.js */

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

        // Verifica pre-navigazione: il pacco esiste ed è libero?
        const parcel = beliefs.parcels.get(id);
        if (!parcel || parcel.carriedBy) throw [`Pacco ${id} non disponibile`];

        console.log(`[PLANS] GoPickUp → (${x},${y})`);
        const nav = await navigateTo(beliefs.me, {x, y}, this.#socket, beliefs.mapTiles, this.shouldStop);
        if (nav === 'stopped') throw ['stopped'];
        if (nav === 'failed')  throw [`Navigazione fallita verso (${x},${y})`];
        if (this.stopped) throw ['stopped'];

        // Verifica post-navigazione: il pacco potrebbe essere sparito
        // o essere stato raccolto da un nemico mentre camminavi
        const freshParcel = beliefs.parcels.get(id);
        if (!freshParcel || freshParcel.carriedBy) throw [`Pacco ${id} sparito durante la navigazione`];

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

    async execute(_action, x, y) {
        if (this.stopped) throw ['stopped'];

        // Guard: inutile navigare se non abbiamo nulla da consegnare
        if (!beliefs.carrying && beliefs.carriedParcels.length === 0)
            throw ['Deliver chiamato senza pacchi da consegnare'];

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

export class WaitAtSpawn extends PlanBase {
    #socket;
    constructor(socket) { super(); this.#socket = socket; }
    static isApplicableTo(action) { return action === 'explore'; }
    //                                      ↑ stessa stringa: options.js non va toccato

    async execute() {
        if (this.stopped) throw ['stopped'];

        // Trova la tile di spawn (type '1') più vicina a me
        const spawnTiles = [...beliefs.mapTiles.entries()]
            .filter(([_, t]) => t.type === '1' || t.type === 1)
            .map(([key, _]) => {
                const [x, y] = key.split('_').map(Number);
                return { x, y };
            });

        if (spawnTiles.length === 0) {
            // Mappa senza tile di spawn: aspetta ferma
            await new Promise(r => setTimeout(r, 300));
            return true;
        }

        const nearest = spawnTiles.reduce((best, t) =>
            smartDist(beliefs.me, t) < smartDist(beliefs.me, best) ? t : best
        );

        console.log(`[PLANS] WaitAtSpawn → (${nearest.x},${nearest.y})`);

        const nav = await navigateTo(
            beliefs.me, nearest, this.#socket, beliefs.mapTiles, this.shouldStop
        );

        if (nav === 'stopped') throw ['stopped'];

        // Arrivati sulla tile di spawn: breve pausa prima di ricontrollare
        await new Promise(r => setTimeout(r, 300));
        return true;
    }
}

export const planLibrary = [GoPickUp, Deliver, WaitAtSpawn];