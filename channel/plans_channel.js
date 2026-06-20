// plans_channel.js — Piani di coordinamento di team (livello 3), estratti da plans.js.

import { PlanBase } from '../bdi/plan_base.js';
import { beliefs, deliverableIds, getBlockedCells } from '../bdi/beliefs.js';
import { navigateTo, reachableDistances } from '../bdi/moves.js';
import {
    markArrived, isRendezvousDone, endRendezvous,
    nearestReachableWithinDist, nearestRowTile, freeNeighborOf,
    isPostmanReady, notifyPostmanReady, notifyDropped, wasDropped,
    notifyRelayDone, clearOverride,
} from './coordination.js';

// Attende che `cond()` sia vera; ritorna false al timeout, lancia ['stopped']
// se l'intenzione viene interrotta.
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
        // Nota: salendo sulla tile l'opportunistic pickup puo' aver gia' raccolto
        // i pacchi, quindi questo emitPickup esplicito spesso torna 0: e' normale.
        const picked = await this.#socket.emitPickup();
        if (picked && picked.length) {
            beliefs.carrying = true;
            beliefs.carriedParcels = [...beliefs.carriedParcels, ...picked];
        }
        const inHand = beliefs.carriedParcels.length;
        console.log(`[COORD] RelayFetch: FASE3 ho ${inHand} pacchi in mano (emitPickup esplicito: ${picked?.length ?? 0}) -> vado a consegnare`);

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


// ─────────────────────────────────────────────────────────────────────────────
// planLibraryChannel — esportata e riunita in plans.js dentro planLibrary.
// ─────────────────────────────────────────────────────────────────────────────

export const planLibraryChannel = [
    GoNearAndWait, GoToRowAndWait, RelayDrop, RelayFetch,
];
