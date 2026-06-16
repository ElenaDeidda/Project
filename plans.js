// plans.js - Piani eseguibili. Il socket viene passato nel costruttore.
import { beliefs, deliverableIds, getBlockedCells } from './beliefs.js';
import { navigateTo, reachableDistances } from './moves.js';
import { smartDist } from './basic_functions.js';
import { getPddlPlan, planToMoves } from './pddl_planner.js';
import {
    markArrived, isRendezvousDone, endRendezvous,
    nearestReachableWithinDist, nearestRowTile, freeNeighborOf,
    isPostmanReady, notifyPostmanReady, notifyDropped, wasDropped,
    notifyRelayDone, clearOverride,
} from './coordination.js';

// Attende che `cond()` sia vera; ritorna false al timeout, lancia ['stopped'] se
// l'intenzione viene interrotta. Usato dai piani di coordinamento (attese di team).
async function waitUntil(cond, shouldStop, timeoutMs = 60000, stepMs = 150) {
    const t0 = Date.now();
    while (!cond()) {
        if (shouldStop && shouldStop()) throw ['stopped'];
        if (Date.now() - t0 > timeoutMs) return false;
        await new Promise(r => setTimeout(r, stepMs));
    }
    return true;
}

// Delivery point piu vicino per distanza REALE di percorso (BFS).
function nearestDeliveryPoint() {
    const dist = reachableDistances(beliefs.me, beliefs.mapTiles, getBlockedCells(), beliefs.isDirectionalMap);
    let best = null, bestD = Infinity;
    for (const dp of beliefs.deliveryPoints) {
        const d = dist.get(`${dp.x}_${dp.y}`);
        if (d != null && d < bestD) { bestD = d; best = dp; }
    }
    return best ?? beliefs.deliveryPoints[0] ?? null;
}

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

        console.log(`[PLANS] GoPickUp -> (${x},${y})`);
        const nav = await navigateTo(beliefs.me, {x, y}, this.#socket, beliefs.mapTiles, this.shouldStop);
        if (nav === 'stopped') throw ['stopped'];
        if (nav === 'failed')  throw [`Navigazione fallita verso (${x},${y})`];
        if (this.stopped) throw ['stopped'];
        // Potrebbe essere gia stato raccolto opportunisticamente durante il tragitto
        if (beliefs.carriedParcels.some(p => p.id === id)) {
            // console.log(`[PLANS] Pacco ${id} gia raccolto in transito`);
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
            // console.log(`[PLANS] GoPickUp PDDL -> (${x},${y})`);
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
                        // Passo rifiutato (nemico sulla tile) -> abbandona PDDL, usa A*
                        // console.warn(`[PLANS] PDDL: passo '${move}' rifiutato - fallback A*`);
                        pddlOk = false;
                        break;
                    }
                }
            }

            // Se il piano PDDL e andato a buon fine fino in fondo, abbiamo finito.
            // (controlliamo se il pacco target e stato effettivamente raccolto)
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
        // console.log(`[PLANS] GoPickUp A* -> (${x},${y})`);
        const nav = await navigateTo(beliefs.me, {x, y}, this.#socket, beliefs.mapTiles, this.shouldStop);
        if (nav === 'stopped') throw ['stopped'];
        if (nav === 'failed')  throw [`Navigazione fallita verso (${x},${y})`];
        if (this.stopped) throw ['stopped'];

        // Potrebbe essere gia stato raccolto opportunisticamente durante il tragitto
        if (beliefs.carriedParcels.some(p => p.id === id)) {
            // console.log(`[PLANS] Pacco ${id} gia raccolto in transito`);
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

        // console.log(`[PLANS] Deliver -> (${x},${y})`);
        const nav = await navigateTo(beliefs.me, {x, y}, this.#socket, beliefs.mapTiles, this.shouldStop);
        if (nav === 'stopped') throw ['stopped'];
        if (nav === 'failed')  throw [`Navigazione fallita verso (${x},${y})`];
        if (this.stopped) throw ['stopped'];

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

        console.log(`[PLANS] GoToSpawn -> (${x},${y})`);
        const nav = await navigateTo(
            beliefs.me, { x, y }, this.#socket, beliefs.mapTiles, this.shouldStop
        );

        if (nav === 'stopped') {
            console.log(`[PLANS] GoToSpawn INTERROTTO verso (${x},${y}) - ora \@ (${Math.round(beliefs.me.x)},${Math.round(beliefs.me.y)})`);
            throw ['stopped'];
        }
        if (nav === 'failed')  throw [`Navigazione fallita verso (${x},${y})`];

        await new Promise(r => setTimeout(r, 300));
        return true;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PIANI DI COORDINAMENTO (livello 3)
// ─────────────────────────────────────────────────────────────────────────────

// TASK 1 - vai entro maxDist da (x,y), avvisa l'arrivo e aspetta l'alleato.
export class GoNearAndWait extends PlanBase {
    #socket;
    constructor(socket) { super(); this.#socket = socket; }
    static isApplicableTo(action) { return action === 'go_near_and_wait'; }

    async execute(_action, x, y, maxDist = 3) {
        if (this.stopped) throw ['stopped'];
        const target = nearestReachableWithinDist({ x, y }, maxDist);
        if (!target) throw [`Nessuna tile raggiungibile entro ${maxDist} da (${x},${y})`];

        console.log(`[COORD] GoNearAndWait -> (${target.x},${target.y}) (<=${maxDist} da (${x},${y}))`);
        const nav = await navigateTo(beliefs.me, target, this.#socket, beliefs.mapTiles, this.shouldStop);
        if (nav === 'stopped') throw ['stopped'];
        if (nav === 'failed')  throw [`Navigazione fallita verso (${target.x},${target.y})`];

        markArrived();
        const ok = await waitUntil(() => isRendezvousDone(), this.shouldStop, 60000);
        if (this.stopped) throw ['stopped'];
        console.log(`[COORD] GoNearAndWait: ${ok ? 'tutti arrivati OK' : 'timeout attesa alleato'}`);
        endRendezvous();
        return true;
    }
}

// TASK 3 - vai su una riga della parita richiesta e congelati (red light).
export class GoToRowAndWait extends PlanBase {
    #socket;
    constructor(socket) { super(); this.#socket = socket; }
    static isApplicableTo(action) { return action === 'go_to_row_and_wait'; }

    async execute(_action, parity = 'odd') {
        if (this.stopped) throw ['stopped'];
        const target = nearestRowTile(parity);
        if (!target) throw [`Nessuna riga ${parity} raggiungibile`];

        console.log(`[COORD] GoToRowAndWait -> (${target.x},${target.y}) riga ${parity}`);
        const nav = await navigateTo(beliefs.me, target, this.#socket, beliefs.mapTiles, this.shouldStop);
        if (nav === 'stopped') throw ['stopped'];
        if (nav === 'failed')  throw [`Navigazione fallita verso (${target.x},${target.y})`];

        beliefs.coord.frozen = true;   // il loop resta fermo finche non arriva "green"
        clearOverride();
        console.log(`[COORD] GoToRowAndWait: su riga ${parity}, FERMO in attesa di "green"`);
        return true;
    }
}

// TASK 2 (raccoglitore) - vai alla tile di handover, ASPETTA il postino, molla.
export class RelayDrop extends PlanBase {
    #socket;
    constructor(socket) { super(); this.#socket = socket; }
    static isApplicableTo(action) { return action === 'relay_drop'; }

    async execute(_action, x, y, ids) {
        if (this.stopped) throw ['stopped'];
        console.log(`[COORD] RelayDrop -> handover (${x},${y})`);
        const nav = await navigateTo(beliefs.me, { x, y }, this.#socket, beliefs.mapTiles, this.shouldStop);
        if (nav === 'stopped') throw ['stopped'];
        if (nav === 'failed')  throw [`Navigazione fallita verso handover (${x},${y})`];

        const ready = await waitUntil(() => isPostmanReady(), this.shouldStop, 60000);
        if (this.stopped) throw ['stopped'];
        if (!ready) console.warn('[COORD] RelayDrop: timeout attesa postino - lascio comunque');

        // Mollo i pacchi REALMENTE in mano adesso (lista fresca, non quella
        // catturata all'avvio: evita drop "a vuoto" se il carico e' cambiato).
        const dropIds = beliefs.carriedParcels.map(p => p.id);
        if (dropIds.length === 0) {
            console.warn('[COORD] RelayDrop: niente in mano da lasciare - annullo handover');
            notifyDropped();          // sblocca comunque il postino (non resta appeso)
            clearOverride();
            return true;
        }
        const dropped = await this.#socket.emitPutdown(dropIds);
        const set = new Set(dropIds);
        beliefs.carriedParcels = beliefs.carriedParcels.filter(p => !set.has(p.id));
        beliefs.carrying = beliefs.carriedParcels.length > 0;
        notifyDropped();
        console.log(`[COORD] RelayDrop: lasciati ${dropped?.length ?? dropIds.length} pacchi su (${x},${y})`);

        // Mi SPOSTO dalla tile di handover, cosi' il postino puo' salirci a
        // raccogliere (altrimenti resta bloccata e lui non arriva mai al pacco).
        const away = freeNeighborOf({ x, y });
        if (away && (away.x !== Math.round(beliefs.me.x) || away.y !== Math.round(beliefs.me.y))) {
            console.log(`[COORD] RelayDrop: mi sposto su (${away.x},${away.y}) per liberare la tile`);
            await navigateTo(beliefs.me, away, this.#socket, beliefs.mapTiles, this.shouldStop);
        }
        clearOverride();
        console.log('[COORD] RelayDrop: fatto -> torno a raccogliere');
        return true;
    }
}

// TASK 2 (postino) - vai alla tile di handover, segnala, raccogli, consegna.
export class RelayFetch extends PlanBase {
    #socket;
    constructor(socket) { super(); this.#socket = socket; }
    static isApplicableTo(action) { return action === 'relay_fetch'; }

    async execute(_action, x, y) {
        if (this.stopped) throw ['stopped'];
        const H = { x, y };
        // Mi avvicino il piu' possibile alla tile di handover: e' (sara') occupata
        // dal raccoglitore, quindi punto alla tile RAGGIUNGIBILE piu' vicina ad essa
        // (un'adiacente, o la piu' vicina possibile) e di li' segnalo "pronto".
        const spot = nearestReachableWithinDist(H, 1);
        const me0 = `(${Math.round(beliefs.me.x)},${Math.round(beliefs.me.y)})`;
        console.log(`[COORD] RelayFetch: FASE1 da ${me0} -> avvicino a (${spot.x},${spot.y}), adiacente a handover (${x},${y})`);
        const nav = await navigateTo(beliefs.me, spot, this.#socket, beliefs.mapTiles, this.shouldStop);
        if (nav === 'stopped') throw ['stopped'];
        if (nav === 'failed')  throw [`Navigazione fallita verso handover (${x},${y})`];
        console.log(`[COORD] RelayFetch: FASE1 arrivato a (${Math.round(beliefs.me.x)},${Math.round(beliefs.me.y)}) -> segnalo "pronto" e aspetto il drop`);

        notifyPostmanReady();
        const ok = await waitUntil(() => wasDropped(), this.shouldStop, 60000);
        if (this.stopped) throw ['stopped'];
        if (!ok) console.warn('[COORD] RelayFetch: timeout (60s) attesa drop del raccoglitore');
        else console.log('[COORD] RelayFetch: FASE2 il raccoglitore ha mollato -> entro sulla tile di handover');

        // Il raccoglitore ha lasciato i pacchi e si sta spostando: entro sulla
        // tile di handover (riprovo finche la libera) e raccolgo. Logghiamo OGNI
        // tentativo: se va "avanti e indietro" qui si vede perche' (tile ancora
        // occupata dal raccoglitore che non si e' ancora spostato).
        let onH = false;
        for (let k = 0; k < 15 && !this.stopped; k++) {
            const r = await navigateTo(beliefs.me, H, this.#socket, beliefs.mapTiles, this.shouldStop);
            const at = `(${Math.round(beliefs.me.x)},${Math.round(beliefs.me.y)})`;
            if (r === 'reached') { onH = true; console.log(`[COORD] RelayFetch: FASE2 sulla tile handover ${at} (tentativo ${k + 1})`); break; }
            if (r === 'stopped') throw ['stopped'];
            console.log(`[COORD] RelayFetch: FASE2 tentativo ${k + 1}: nav=${r}, sono a ${at}, la tile (${x},${y}) e' ancora occupata -> riprovo`);
            await new Promise(res => setTimeout(res, 200));
        }
        if (!onH) console.warn(`[COORD] RelayFetch: non sono riuscito a salire su (${x},${y}) dopo 15 tentativi -> provo a raccogliere comunque`);
        const picked = await this.#socket.emitPickup();
        if (picked && picked.length) {
            beliefs.carrying = true;
            beliefs.carriedParcels = [...beliefs.carriedParcels, ...picked];
        }
        console.log(`[COORD] RelayFetch: FASE3 raccolti ${picked?.length ?? 0} pacchi -> vado a consegnare`);

        const target = nearestDeliveryPoint();
        if (target) {
            console.log(`[COORD] RelayFetch: FASE3 consegno a (${target.x},${target.y})`);
            const dn = await navigateTo(beliefs.me, target, this.#socket, beliefs.mapTiles, this.shouldStop);
            if (dn === 'stopped') throw ['stopped'];
            const dids = deliverableIds(beliefs);
            if (dids.length) {
                await this.#socket.emitPutdown(dids);
                const set = new Set(dids);
                beliefs.carriedParcels = beliefs.carriedParcels.filter(p => !set.has(p.id));
                beliefs.carrying = beliefs.carriedParcels.length > 0;
            }
        } else {
            console.warn('[COORD] RelayFetch: nessun delivery point raggiungibile!');
        }
        beliefs.coord._handover = null;
        beliefs.coord._dropped  = false;
        clearOverride();
        notifyRelayDone();   // sblocco il raccoglitore: puo cedere il prossimo carico
        console.log(`[COORD] RelayFetch: CONSEGNATO OK Score: ${beliefs.me.score}`);
        return true;
    }
}

export const planLibrary = [
    GoPickUp, Deliver, GoToSpawn,
    GoNearAndWait, GoToRowAndWait, RelayDrop, RelayFetch,
];
