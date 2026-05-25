// intentions.js — IntentionRevision e IntentionDeliberation.
// Il socket viene passato nel costruttore e inoltrato ai piani.

import { planLibrary } from './plans.js';

export class IntentionRevision {
    #socket;
    #current    = null;
    #currentKey = null;
    #isRunning  = false;
    #chain      = Promise.resolve();

    constructor(socket) {
        this.#socket = socket;
    }

    push(predicate) {
        const key = _predicateKey(predicate);
        if (this.#isRunning && key === this.#currentKey) return;

        if (this.#isRunning && key !== this.#currentKey)
            console.log(`[INTENTIONS] CAMBIO: ${this.#currentKey} → ${key}`);

        this.#current?.stop();

        const intention  = new IntentionDeliberation(predicate, this.#socket);
        this.#current    = intention;
        this.#currentKey = key;
        this.#isRunning  = true;

        // Serializza le intenzioni: il nuovo achieve() parte solo dopo che il
        // precedente si è risolto (azione socket in volo inclusa). Senza questo
        // due emitMove/emitPickup si sovrappongono → penalità dal server.
        this.#chain = this.#chain.then(async () => {
            if (this.#current !== intention) return;   // già soppiantata da un push successivo

            console.log(`[INTENTIONS] → ${predicate[0]}(${predicate.slice(1,3).join(',')})`);
            try {
                await intention.achieve();
            } catch (err) {
                if (!Array.isArray(err) || err[0] !== 'stopped')
                    console.warn(`[INTENTIONS] Fallita [${predicate[0]}]:`, err);
            } finally {
                if (this.#current === intention) {
                    this.#isRunning  = false;
                    this.#current    = null;
                    this.#currentKey = null;
                }
            }
        });
    }

    stop() { this.#current?.stop(); }
}

class IntentionDeliberation {
    #predicate;
    #socket;
    #currentPlan = null;
    #stopped     = false;

    get stopped() { return this.#stopped; }

    constructor(predicate, socket) {
        this.#predicate = predicate;
        this.#socket    = socket;
    }

    stop() {
        this.#stopped = true;
        this.#currentPlan?.stop();
    }

    async achieve() {
        for (const PlanClass of planLibrary) {
            if (this.#stopped) throw ['stopped'];
            if (!PlanClass.isApplicableTo(...this.#predicate)) continue;

            this.#currentPlan = new PlanClass(this.#socket);
            try {
                return await this.#currentPlan.execute(...this.#predicate);
            } catch (err) {
                if (Array.isArray(err) && err[0] === 'stopped') throw err;
                console.warn(`[INTENTIONS] Piano ${PlanClass.name} fallito:`, err);
            }
        }
        throw [`Nessun piano per`, ...this.#predicate];
    }
}

function _predicateKey(p) {
    if (p[0] === 'go_pick_up')  return `${p[0]}_${p[1]}_${p[2]}_${p[3]}`;
    if (p[0] === 'deliver')     return `${p[0]}_${p[1]}_${p[2]}`;
    if (p[0] === 'go_to_spawn') return p[1] != null ? `${p[0]}_${p[1]}_${p[2]}` : p[0];
    return p[0];
}
