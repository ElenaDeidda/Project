// coordination.js - Task cooperativi di livello 3 (comunicazione BDI ↔ LLM).
// Caricato da ENTRAMBI i processi (main.js e llm_main.js). Si appoggia a
// communication.js per i messaggi di team e pilota i loop BDI tramite
// `beliefs.coord` ({ frozen, override, role }).
//
// Tre task:
//   1) RENDEZVOUS  - entrambi entro distanza <= maxDist da (x,y) e si aspettano.
//   2) STAFFETTA   - un pacco preso da un agente e consegnato dall'altro (+bonus).
//                    Ruoli: BDI = raccoglitore, LLM = postino. "Incontro poi mollo":
//                    il raccoglitore va alla tile di handover e ASPETTA il postino,
//                    poi lascia i pacchi; il postino li recupera e consegna.
//   3) RED LIGHT   - tutti su una riga DISPARI, poi freeze finche non arriva il
//                    messaggio "green" (relay dell'LLM) -> ripartono; "red" -> fermi.

import { beliefs, getBlockedCells, deliverableIds } from './beliefs.js';
import { initComms, broadcast, sendTo, onTeamMessage, getTeammates } from './communication.js';
import { reachableDistances } from './moves.js';

let _socket = null;
let _started = false;

function log(msg) { console.log(`[COORD:${beliefs?.me?.name || '?'}] ${msg}`); }

function defaultCoord() {
    return {
        frozen:   false,    // red light: il loop BDI resta fermo
        override: null,     // predicate forzata (es. ['go_near_and_wait', x, y, d])
        role:     null,     // 'collector' | 'postman' (staffetta)

        // ── stato interno dei task ──────────────────────────────────────────
        _rzv:        null,  // { x, y, maxDist } rendezvous attivo
        _arrived:    new Set(),
        _redlight:   false, // task red-light attivo (per intercettare green/red)
        _postman:    null,  // id del postino (lato collector)
        _collector:  null,  // id del raccoglitore (lato postman)
        _handover:   null,  // { tile:{x,y}, ids:[...] } handover in corso (postman)
        _postmanReady: false, // il postino e arrivato alla tile di handover (collector)
        _dropped:    false, // il collector ha lasciato i pacchi (postman)
        _relayBusy:  false, // collector: handover in corso, NON avviarne un altro
        _dropTile:   null,  // collector: tile dove ho ceduto i pacchi (non ri-raccoglierli)
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// INIT - chiamare dopo onYou (beliefs.me.teamId popolato)
// ─────────────────────────────────────────────────────────────────────────────

export function initCoordination(socket) {
    if (_started) return;
    _started = true;
    _socket  = socket;
    beliefs.coord = defaultCoord();

    initComms(socket, beliefs);   // accende il canale di team (hello + onMsg)

    // ── RENDEZVOUS (task 1) ────────────────────────────────────────────────
    onTeamMessage('coord_rendezvous', (p) => beginRendezvous(p.x, p.y, p.maxDist, false));
    onTeamMessage('coord_arrived', (_p, from) => {
        beliefs.coord._arrived.add(from);
        log(`arrivato l'alleato ${from} (arrivati: ${beliefs.coord._arrived.size})`);
    });

    // ── STAFFETTA (task 2) ─────────────────────────────────────────────────
    onTeamMessage('coord_relay_start', (_p, from) => {
        beliefs.coord.role     = 'collector';
        beliefs.coord._postman = from;
        log(`staffetta: sono il RACCOGLITORE, postino = ${from}`);
    });
    onTeamMessage('coord_handover', (p, from) => {       // lato POSTINO
        const c = beliefs.coord;
        // Un fetch e gia in corso -> ignoro (la staffetta e serializzata: il
        // raccoglitore non dovrebbe mandarne un altro finche non consegno).
        if (c.override?.[0] === 'relay_fetch') {
            log(`staffetta: handover (${p.tile.x},${p.tile.y}) ignorato - sto gia recuperando`);
            return;
        }
        c._collector = from;
        c._handover  = { tile: p.tile, ids: p.ids ?? [] };
        c._dropped   = false;
        c.override   = ['relay_fetch', p.tile.x, p.tile.y];
        log(`staffetta: ricevuto handover su (${p.tile.x},${p.tile.y}) - vado a recuperare`);
    });
    onTeamMessage('coord_postman_ready', () => {         // lato RACCOGLITORE
        beliefs.coord._postmanReady = true;
        log('staffetta: il postino e pronto sulla tile di handover');
    });
    onTeamMessage('coord_dropped', () => {               // lato POSTINO
        beliefs.coord._dropped = true;
        log('staffetta: il raccoglitore ha lasciato i pacchi -> li prendo');
    });
    onTeamMessage('coord_relay_done', () => {            // lato RACCOGLITORE
        beliefs.coord._relayBusy = false;
        beliefs.coord._dropTile  = null;
        log('staffetta: il postino ha CONSEGNATO -> posso cedere il prossimo carico');
    });

    // ── RED LIGHT (task 3) ─────────────────────────────────────────────────
    onTeamMessage('coord_redlight_start', (p) => beginRedLight(p.row ?? 'odd', false));
    onTeamMessage('coord_go',   () => { beliefs.coord.frozen = false; log('GREEN GREEN -> riparto'); });
    onTeamMessage('coord_stop', () => { beliefs.coord.frozen = true;  log('RED RED -> fermo'); });

    log(`inizializzato (team=${beliefs.me.teamId || '??'})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// AVVIO DEI TASK (chiamati dall'agente LLM dopo aver capito la missione)
// ─────────────────────────────────────────────────────────────────────────────

/** TASK 1: porta me entro maxDist da (x,y) e aspetta l'alleato. */
export function startRendezvous(x, y, maxDist = 3) {
    beginRendezvous(x, y, maxDist, true);
    return `Rendezvous avviato verso (${x},${y}) entro ${maxDist}`;
}

/** TASK 2: io divento il POSTINO; l'alleato diventa il raccoglitore. */
export function startRelayAsPostman() {
    beliefs.coord.role = 'postman';
    broadcast('coord_relay_start', {});
    log('staffetta: sono il POSTINO, attendo handover dal raccoglitore');
    return 'Staffetta avviata: io = postino, alleato = raccoglitore';
}

/** TASK 3: vai su una riga dispari e congelati fino al "green". */
export function startRedLight(row = 'odd') {
    beginRedLight(row, true);
    return `Red light avviato: vado su riga ${row} e attendo il "green"`;
}

/** Variante single-agent (family reactive): freeze SUL POSTO fino al "green". */
export function startFreezeInPlace() {
    beliefs.coord._redlight = true;
    beliefs.coord.frozen    = true;
    log('reactive: FERMO sul posto, attendo "green"');
    return 'Freeze attivato: fermo finche non arriva "green"';
}

function beginRendezvous(x, y, maxDist, broadcastIt) {
    beliefs.coord._rzv     = { x, y, maxDist };
    beliefs.coord._arrived = new Set();
    beliefs.coord.override = ['go_near_and_wait', x, y, maxDist];
    log(`rendezvous: vado entro ${maxDist} da (${x},${y})`);
    if (broadcastIt) broadcast('coord_rendezvous', { x, y, maxDist });
}

function beginRedLight(row, broadcastIt) {
    beliefs.coord._redlight = true;
    beliefs.coord.override  = ['go_to_row_and_wait', row];
    log(`red light: vado su una riga ${row} e poi mi fermo`);
    if (broadcastIt) broadcast('coord_redlight_start', { row });
}

// ─────────────────────────────────────────────────────────────────────────────
// SEGNALE ADMIN (red light): "green"/"red" in chat -> relay al team
// ─────────────────────────────────────────────────────────────────────────────

const GO_WORDS   = /\b(green|go|via|avanti|start)\b/i;
const STOP_WORDS = /\b(red|stop|alt|ferm)\b/i;

/**
 * Se e in corso un red-light e il testo e un segnale breve, lo gestisce
 * (relay 'coord_go'/'coord_stop' al team) e ritorna true -> NON e una missione.
 */
export function maybeHandleAdminSignal(text) {
    const t = String(text || '').trim();
    if (!beliefs.coord?._redlight) return false;
    if (t.length > 25) return false;            // le missioni vere sono piu lunghe
    if (GO_WORDS.test(t)) {
        log('segnale admin GREEN -> broadcast go');
        beliefs.coord.frozen = false;
        broadcast('coord_go', {});
        return true;
    }
    if (STOP_WORDS.test(t)) {
        log('segnale admin RED -> broadcast stop');
        beliefs.coord.frozen = true;
        broadcast('coord_stop', {});
        return true;
    }
    return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// USATO DAI PIANI / LOOP
// ─────────────────────────────────────────────────────────────────────────────

/** Marca il MIO arrivo (rendezvous) e avvisa il team. */
export function markArrived() {
    beliefs.coord._arrived.add(beliefs.me.id);
    broadcast('coord_arrived', {});
    log(`sono arrivato (arrivati: ${beliefs.coord._arrived.size})`);
}

/** true quando io + tutti gli alleati noti sono arrivati. */
export function isRendezvousDone() {
    const expected = getTeammates().length + 1;             // alleati + me
    return beliefs.coord._arrived.size >= Math.max(2, expected);
}

export function endRendezvous() {
    beliefs.coord._rzv = null;
    beliefs.coord.override = null;
    log('rendezvous COMPLETO -> riprendo il gioco normale');
}

export const isPostmanReady = () => !!beliefs.coord?._postmanReady;
export const wasDropped     = () => !!beliefs.coord?._dropped;
export const getHandover    = () => beliefs.coord?._handover ?? null;

/** Il postino segnala al raccoglitore di essere pronto sulla tile. */
export function notifyPostmanReady() {
    const to = beliefs.coord?._collector;
    if (to) sendTo(to, 'coord_postman_ready', {});
    log('staffetta: ho avvisato il raccoglitore che sono pronto');
}

/** Il raccoglitore segnala al postino di aver lasciato i pacchi. */
export function notifyDropped() {
    const to = beliefs.coord?._postman;
    if (to) sendTo(to, 'coord_dropped', {});
    log('staffetta: ho avvisato il postino di aver lasciato i pacchi');
}

/** Il postino segnala al raccoglitore di aver CONSEGNATO (sblocca il prossimo). */
export function notifyRelayDone() {
    const to = beliefs.coord?._collector;
    if (to) sendTo(to, 'coord_relay_done', {});
    log('staffetta: ho avvisato il raccoglitore di aver consegnato');
}

/** true se NON devo raccogliere il pacco in (x,y): e quello appena ceduto al
 *  postino (evita che il raccoglitore se lo ri-prenda creando un loop). */
export function isReservedForPostman(x, y) {
    const c = beliefs.coord;
    return !!(c && c.role === 'collector' && c._relayBusy && c._dropTile
        && Math.round(x) === c._dropTile.x && Math.round(y) === c._dropTile.y);
}

export function clearOverride() { if (beliefs.coord) beliefs.coord.override = null; }

// ─────────────────────────────────────────────────────────────────────────────
// INTERCETTAZIONE DELLA CONSEGNA (lato RACCOGLITORE, staffetta)
// Se sto per consegnare ma sono il raccoglitore -> dirotto i pacchi su una tile
// di handover a meta strada e avviso il postino.
// ─────────────────────────────────────────────────────────────────────────────

export function relayInterceptDeliver(predicate) {
    const c = beliefs.coord;
    if (!c || c.role !== 'collector') return predicate;
    if (c.override) return c.override;                       // handover gia in corso
    if (!Array.isArray(predicate) || predicate[0] !== 'deliver') return predicate;

    // Staffetta SERIALIZZATA: un handover alla volta. Se il postino non ha ancora
    // consegnato il carico precedente, NON ne avvio un altro - tengo i pacchi e
    // aspetto (resto in zona senza consegnare da solo, per non perdere il bonus).
    if (c._relayBusy) {
        log('staffetta: postino ancora in consegna -> aspetto prima di cedere altro');
        return ['go_to_spawn'];
    }

    const delivery = { x: predicate[1], y: predicate[2] };
    const H   = handoverTile(beliefs.me, delivery);
    const ids = deliverableIds(beliefs);
    if (!H || ids.length === 0) return predicate;            // fallback: consegna normale

    c._relayBusy    = true;
    c._dropTile     = { x: H.x, y: H.y };
    c._postmanReady = false;
    c.override      = ['relay_drop', H.x, H.y, ids];
    sendTo(c._postman, 'coord_handover', { tile: H, ids });
    log(`staffetta: consegna dirottata sulla tile di handover (${H.x},${H.y}) - ${ids.length} pacchi`);
    return c.override;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER GEOMETRICI (riusano il BFS reachableDistances)
// ─────────────────────────────────────────────────────────────────────────────

const manhattan = (ax, ay, bx, by) => Math.abs(ax - bx) + Math.abs(ay - by);

function reachMap() {
    return reachableDistances(beliefs.me, beliefs.mapTiles, getBlockedCells(), beliefs.isDirectionalMap);
}

/** Tile RAGGIUNGIBILE piu vicina a ME che sia entro `maxDist` (Manhattan) da `point`. */
export function nearestReachableWithinDist(point, maxDist) {
    const dist = reachMap();
    let best = null, bestD = Infinity;
    for (const [key, d] of dist) {
        const [x, y] = key.split('_').map(Number);
        if (manhattan(x, y, point.x, point.y) > maxDist) continue;
        if (d < bestD) { bestD = d; best = { x, y }; }
    }
    // fallback: nessuna tile entro maxDist raggiungibile -> la piu vicina al punto
    if (!best) {
        let bestM = Infinity;
        for (const [key] of dist) {
            const [x, y] = key.split('_').map(Number);
            const m = manhattan(x, y, point.x, point.y);
            if (m < bestM) { bestM = m; best = { x, y }; }
        }
    }
    return best;
}

/** Tile vicina (adiacente) a `tile` raggiungibile da ME, o `tile` se nessuna.
 *  Usata dal postino per avvicinarsi alla tile di handover SENZA occuparla
 *  (mentre il raccoglitore ci sta sopra). */
export function freeNeighborOf(tile) {
    const dist = reachMap();
    const cand = [
        { x: tile.x + 1, y: tile.y }, { x: tile.x - 1, y: tile.y },
        { x: tile.x, y: tile.y + 1 }, { x: tile.x, y: tile.y - 1 },
    ];
    let best = null, bestD = Infinity;
    for (const c of cand) {
        const d = dist.get(`${c.x}_${c.y}`);
        if (d != null && d < bestD) { bestD = d; best = c; }
    }
    return best ?? tile;
}

/** Tile RAGGIUNGIBILE piu vicina a ME con riga (y) della parita richiesta. */
export function nearestRowTile(parity = 'odd') {
    const want = parity === 'even' ? 0 : 1;
    const dist = reachMap();
    let best = null, bestD = Infinity;
    for (const [key, d] of dist) {
        const [x, y] = key.split('_').map(Number);
        if ((y % 2 + 2) % 2 !== want) continue;
        if (d < bestD) { bestD = d; best = { x, y }; }
    }
    return best;
}

/**
 * Tile di handover: tra le tile raggiungibili da ME, quella piu vicina al punto
 * medio fra me e la delivery (cosi il postino fa il tragitto residuo). Riusa il
 * BFS per garantire che sia effettivamente raggiungibile.
 */
export function handoverTile(me, delivery) {
    const midX = (me.x + delivery.x) / 2;
    const midY = (me.y + delivery.y) / 2;
    const dist = reachMap();
    let best = null, bestM = Infinity;
    for (const [key] of dist) {
        const [x, y] = key.split('_').map(Number);
        // evita di scegliere proprio la delivery (vogliamo che consegni il postino)
        if (x === Math.round(delivery.x) && y === Math.round(delivery.y)) continue;
        const m = Math.abs(x - midX) + Math.abs(y - midY);
        if (m < bestM) { bestM = m; best = { x, y }; }
    }
    return best;
}
