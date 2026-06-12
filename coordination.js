// coordination.js
// ─────────────────────────────────────────────────────────────────────────────
// Esecuzione delle missioni L3 (coordinamento multi-agente), lato agente LLM.
// L'agente LLM fa da REGISTA: decide i target per entrambi e manda al BDI
// solo comandi semplici via team_commands ('cmd' goto/hold/resume/pickup/
// deliver). Il BDI resta un BDI puro che riceve goal dal compagno.
//
// Sottotipi (estratti dal parser):
//   meet_at   "entrambi gli agenti entro distanza d da (x,y), aspettatevi"
//   handoff   "un pacco raccolto da un agente e consegnato dall'altro"
//   hold_rows "tutti su una riga dispari/pari, fermi finché non arriva
//              il nostro messaggio" (red light / green light)
// ─────────────────────────────────────────────────────────────────────────────

import { onTeamMessage, sendTo, broadcast, getTeammates, askTeammate } from './communication.js';

const ARRIVAL_TIMEOUT_MS  = 90_000;   // attesa max per un goto del compagno
const GREENLIGHT_TIMEOUT_MS = 300_000; // attesa max del "semaforo verde"
const DISCOVERY_TRIES     = 5;        // tentativi di trovare il compagno

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const dist  = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

// ── Plumbing: ack dei comandi e semaforo verde ───────────────────────────────

const _cmdWaiters   = new Map();   // action → resolve(payload)
const _greenWaiters = new Map();   // senderId → resolve(text)
let _inited = false;

function ensureInit() {
    if (_inited) return;
    _inited = true;
    onTeamMessage('cmd_done', (payload) => {
        const r = _cmdWaiters.get(payload?.action);
        if (r) { _cmdWaiters.delete(payload.action); r(payload); }
    });
    onTeamMessage('pong', () => { /* registra il mittente via communication.js */ });
}

function waitCmdDone(action, timeoutMs = ARRIVAL_TIMEOUT_MS) {
    return new Promise((resolve) => {
        _cmdWaiters.set(action, resolve);
        setTimeout(() => {
            if (_cmdWaiters.get(action) === resolve) {
                _cmdWaiters.delete(action);
                resolve(null);   // timeout → il chiamante decide
            }
        }, timeoutMs);
    });
}

/**
 * Da chiamare nell'onMsg della chat per OGNI messaggio in arrivo: se stiamo
 * aspettando il "semaforo verde" dal mittente della missione hold_rows, il
 * messaggio è il via libera e viene CONSUMATO (non va in coda missioni).
 * @returns {boolean} true se il messaggio è stato consumato
 */
export function notifyChatMessage(senderId, text) {
    const r = _greenWaiters.get(senderId);
    if (!r) return false;
    _greenWaiters.delete(senderId);
    r(text);
    return true;
}

function waitGreenLight(senderId, timeoutMs = GREENLIGHT_TIMEOUT_MS) {
    return new Promise((resolve) => {
        _greenWaiters.set(senderId, resolve);
        setTimeout(() => {
            if (_greenWaiters.get(senderId) === resolve) {
                _greenWaiters.delete(senderId);
                resolve(null);
            }
        }, timeoutMs);
    });
}

// ── Scoperta del compagno ────────────────────────────────────────────────────
// L'handshake 'hello' di communication.js di solito basta; se i processi sono
// partiti in momenti diversi si insiste con un ping (il BDI risponde pong).
async function findTeammate() {
    for (let i = 0; i < DISCOVERY_TRIES; i++) {
        const mates = getTeammates();
        if (mates.length > 0) return mates[0];
        broadcast('ping', {});
        await sleep(1000);
    }
    return null;
}

// ── Geometria sui beliefs ────────────────────────────────────────────────────

function walkable(beliefs) {
    return [...beliefs.mapTiles.entries()]
        .filter(([, t]) => t.type !== '0' && t.type !== 0)
        .map(([k]) => { const [x, y] = k.split('_').map(Number); return { x, y }; });
}

// Tile percorribili entro distanza d da (x,y), ordinate per vicinanza a `from`
function tilesNear(center, d, beliefs, from) {
    return walkable(beliefs)
        .filter(t => dist(t, center) <= d)
        .sort((a, b) => dist(a, from) - dist(b, from));
}

// La tile percorribile più vicina a `from` su una riga di parità `parity`
function nearestRowTile(parity, from, beliefs, exclude = null) {
    const cands = walkable(beliefs)
        .filter(t => t.y % 2 === parity)
        .filter(t => !exclude || t.x !== exclude.x || t.y !== exclude.y)
        .sort((a, b) => dist(a, from) - dist(b, from));
    return cands[0] ?? null;
}

// Una tile percorribile adiacente a `t` (per la staffetta: il punto di scambio
// è la tile SUBITO PRIMA della delivery, come da strategia)
function adjacentWalkable(t, beliefs, from) {
    const cands = [
        { x: t.x + 1, y: t.y }, { x: t.x - 1, y: t.y },
        { x: t.x, y: t.y + 1 }, { x: t.x, y: t.y - 1 },
    ].filter(c => {
        const tile = beliefs.mapTiles.get(`${c.x}_${c.y}`);
        return tile && tile.type !== '0' && tile.type !== 0;
    });
    cands.sort((a, b) => dist(a, from) - dist(b, from));
    return cands[0] ?? null;
}

function nearestDelivery(beliefs) {
    const dps = beliefs.deliveryPoints ?? [];
    if (!dps.length) return null;
    return dps.reduce((best, d) => dist(d, beliefs.me) < dist(best, beliefs.me) ? d : best);
}

function nearestFreeParcel(beliefs) {
    const free = [...(beliefs.parcels?.values() ?? [])].filter(p => !p.carriedBy);
    if (!free.length) return null;
    return free.reduce((best, p) => dist(p, beliefs.me) < dist(best, beliefs.me) ? p : best);
}

async function goTo(target, ctx, signal, opts = {}) {
    const { beliefs, socket, deps } = ctx;
    return await deps.navigateTo(
        beliefs.me, { x: target.x, y: target.y }, socket, beliefs.mapTiles,
        () => signal?.aborted === true, 3, opts.opportunistic ?? true,
    );
}

// ── I TRE SOTTOTIPI ──────────────────────────────────────────────────────────

// "Move both agents to the neighborhood of (x,y) within max distance d,
//  and have them wait for each other."
async function meetAt(coord, mate, ctx, signal) {
    const { beliefs } = ctx;
    const center = { x: Number(coord.x), y: Number(coord.y) };
    const d      = Number(coord.max_distance ?? 3);

    const matePos = await askTeammate(mate, 'where_are_you', {}, 3000) ?? center;
    const spotsForMate = tilesNear(center, d, beliefs, matePos);
    if (!spotsForMate.length) throw new Error(`nessuna tile percorribile entro ${d} da (${center.x},${center.y})`);
    const mateSpot = spotsForMate[0];
    const mySpot   = tilesNear(center, d, beliefs, beliefs.me)
        .find(t => t.x !== mateSpot.x || t.y !== mateSpot.y) ?? mateSpot;

    console.log(`[COORD] meet_at (${center.x},${center.y})±${d}: io→(${mySpot.x},${mySpot.y}) compagno→(${mateSpot.x},${mateSpot.y})`);
    // il waiter va registrato PRIMA di mandare il comando, sennò un ack
    // velocissimo andrebbe perso
    const ackPromise = waitCmdDone('goto');
    sendTo(mate, 'cmd', { action: 'goto', x: mateSpot.x, y: mateSpot.y, hold: true });

    const nav = await goTo(mySpot, ctx, signal);
    if (nav === 'stopped') return null;
    if (nav !== 'reached') throw new Error(`non raggiungo (${mySpot.x},${mySpot.y})`);

    const ack = await ackPromise;
    if (signal?.aborted) return null;
    if (!ack?.ok) throw new Error('il compagno non è arrivato in tempo');

    // "wait for each other": entrambi in posizione, restiamo fermi un attimo
    // perché il server registri la condizione, poi si riparte.
    await sleep(3000);
    return `entrambi nel raggio ${d} di (${center.x},${center.y})`;
}

// "Parcel picked up by one agent, delivered by the other" — staffetta:
// io (LLM) raccolgo, deposito sulla tile accanto alla delivery, mi sposto,
// e il BDI fa l'ultimo miglio: pickup + consegna.
async function handoff(mate, ctx, signal) {
    const { beliefs, socket } = ctx;

    sendTo(mate, 'cmd', { action: 'hold' });

    const parcel = nearestFreeParcel(beliefs);
    if (!parcel) throw new Error('nessun pacco libero in vista per la staffetta');
    console.log(`[COORD] handoff: raccolgo ${parcel.id} @ (${Math.round(parcel.x)},${Math.round(parcel.y)})`);
    const nav1 = await goTo(parcel, ctx, signal);            // opportunistico: raccoglie
    if (nav1 === 'stopped') return null;
    if (nav1 !== 'reached') throw new Error('pacco della staffetta irraggiungibile');
    await socket.emitPickup();

    const dp = nearestDelivery(beliefs);
    if (!dp) throw new Error('nessuna delivery nota');
    const transfer = adjacentWalkable(dp, beliefs, beliefs.me);
    if (!transfer) throw new Error('nessuna tile di scambio accanto alla delivery');

    // opportunistic=false: NON devo consegnare io — il bonus vale solo se
    // consegna l'altro agente.
    console.log(`[COORD] handoff: porto il pacco al punto di scambio (${transfer.x},${transfer.y})`);
    const nav2 = await goTo(transfer, ctx, signal, { opportunistic: false });
    if (nav2 === 'stopped') return null;
    if (nav2 !== 'reached') throw new Error('punto di scambio irraggiungibile');

    const ids = (beliefs.carriedParcels ?? []).map(p => p.id);
    await socket.emitPutdown(ids.length ? ids : undefined);
    beliefs.carriedParcels = [];
    beliefs.carrying       = false;

    // Mi tolgo di mezzo (il compagno deve poter stare sulla tile di scambio)
    const aside = adjacentWalkable(transfer, beliefs, dp) ?? dp;
    await goTo(aside, ctx, signal, { opportunistic: false });
    if (signal?.aborted) return null;

    console.log(`[COORD] handoff: passo il testimone al compagno`);
    const goAck = waitCmdDone('goto');
    sendTo(mate, 'cmd', { action: 'goto', x: transfer.x, y: transfer.y, hold: true });
    const a1 = await goAck;
    if (!a1?.ok) throw new Error('il compagno non è arrivato al punto di scambio');

    const pickAck = waitCmdDone('pickup', 10_000);
    sendTo(mate, 'cmd', { action: 'pickup' });
    const a2 = await pickAck;
    if (!a2?.ok || !(a2.picked?.length > 0)) throw new Error('il compagno non ha raccolto il pacco');

    const delAck = waitCmdDone('deliver');
    sendTo(mate, 'cmd', { action: 'deliver' });
    const a3 = await delAck;
    if (!a3?.ok) throw new Error('il compagno non è riuscito a consegnare');

    return `staffetta completata: io ho raccolto, il compagno ha consegnato ${a3.delivered ?? '?'} pacchi`;
}

// "All agents must move to an odd-numbered row and wait for our message
//  before moving again" — red light / green light.
async function holdRows(coord, mate, ctx, signal, senderId) {
    const { beliefs } = ctx;
    const parity = coord.parity === 'even' ? 0 : 1;

    const matePos    = await askTeammate(mate, 'where_are_you', {}, 3000) ?? beliefs.me;
    const mateTarget = nearestRowTile(parity, matePos, beliefs);
    if (!mateTarget) throw new Error(`nessuna riga ${parity ? 'dispari' : 'pari'} percorribile`);
    const myTarget   = nearestRowTile(parity, beliefs.me, beliefs, mateTarget) ?? mateTarget;

    console.log(`[COORD] hold_rows(${parity ? 'dispari' : 'pari'}): io→(${myTarget.x},${myTarget.y}) compagno→(${mateTarget.x},${mateTarget.y})`);
    const ackPromise = waitCmdDone('goto');
    sendTo(mate, 'cmd', { action: 'goto', x: mateTarget.x, y: mateTarget.y, hold: true });

    const nav = await goTo(myTarget, ctx, signal);
    if (nav === 'stopped') return null;
    if (nav !== 'reached') throw new Error('non raggiungo la riga richiesta');

    const ack = await ackPromise;
    if (!ack?.ok) throw new Error('il compagno non è arrivato sulla riga');

    // Semaforo rosso: ENTRAMBI fermi finché il mittente non rimanda un
    // messaggio (qualsiasi). Il mio BDI è già in pausa (missione in corso);
    // il compagno è in hold.
    console.log(`[COORD] hold_rows: in attesa del semaforo verde da ${senderId}...`);
    const green = await waitGreenLight(senderId);
    if (signal?.aborted) return null;
    if (green === null) console.warn('[COORD] hold_rows: timeout semaforo verde, riparto comunque');
    else console.log(`[COORD] hold_rows: 🟢 "${green}"`);

    return green === null ? 'fermi sulla riga, semaforo verde mai arrivato (timeout)'
                          : 'semaforo verde ricevuto, si riparte';
}

// ── ENTRY POINT ──────────────────────────────────────────────────────────────

/**
 * Esegue una missione L3 usando il sottotipo strutturato del parser.
 * In QUALSIASI uscita (successo, errore, abort) il compagno viene rilasciato
 * con 'resume': mai lasciare il BDI in hold per un errore nostro.
 */
export async function executeCoordination(text, verdict, ctx, signal) {
    ensureInit();
    const coord = verdict.coordination;

    const mate = await findTeammate();
    if (!mate) throw new Error('compagno di squadra non trovato (è acceso?): rinuncio');

    try {
        switch (coord.type) {
            case 'meet_at':   return await meetAt(coord, mate, ctx, signal);
            case 'handoff':   return await handoff(mate, ctx, signal);
            case 'hold_rows': return await holdRows(coord, mate, ctx, signal, ctx.lastSender);
            default: throw new Error(`sottotipo coordinamento sconosciuto: ${coord.type}`);
        }
    } finally {
        sendTo(mate, 'cmd', { action: 'resume' });
    }
}
