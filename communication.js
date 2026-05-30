// communication.js
// Canale di comunicazione tra l'agente BDI e l'agente LLM dello stesso team.
// Riconoscimento team via TEAM_ID condiviso nel .env (i messaggi senza il token
// giusto vengono ignorati → non confondiamo i nemici per alleati).
//
// USO:
//   import { initComms, shareBeliefs, onTeamMessage, askTeammate } from './communication.js';
//   initComms(socket);
//   onTeamMessage('parcels_update', (payload, from) => { ...aggiorna beliefs... });
//   shareBeliefs(beliefs);

const TEAM_ID = process.env.TEAM_ID || 'TEAM_DEFAULT';
const MY_ROLE = process.env.ROLE   || 'peer'; // 'bdi' | 'llm' | 'peer'

let _socket = null;
const _handlers = new Map();          // type -> [callback]
const _teammates = new Set();         // id degli alleati confermati
const _pendingAsks = new Map();       // askId -> resolve()


// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────

export function initComms(socket) {
    _socket = socket;

    // Tutti i messaggi del team passano da qui
    socket.onMsg((id, name, msg, reply) => {
        // Scarta messaggi che non sono del nostro team
        if (!msg || msg.teamId !== TEAM_ID) return;

        // Registra l'alleato
        if (id) _teammates.add(id);

        // Risposta a una ask in sospeso
        if (msg.type === '__reply__' && _pendingAsks.has(msg.askId)) {
            _pendingAsks.get(msg.askId)(msg.payload);
            _pendingAsks.delete(msg.askId);
            return;
        }

        // Se è una ask, e ho un handler che ritorna qualcosa → rispondo
        if (msg.type === '__ask__' && typeof reply === 'function') {
            const handler = _handlers.get(msg.innerType)?.[0];
            const answer  = handler ? handler(msg.payload, id) : null;
            reply({ teamId: TEAM_ID, type: '__reply__', askId: msg.askId, payload: answer });
            return;
        }

        // Messaggio normale → invoca tutti gli handler registrati
        const cbs = _handlers.get(msg.type) || [];
        for (const cb of cbs) cb(msg.payload, id);
    });

    // Handshake iniziale: annuncio la mia presenza al team
    socket.emitShout({ teamId: TEAM_ID, type: 'hello', payload: { role: MY_ROLE } });
    console.log(`[COMMS] Inizializzato — team=${TEAM_ID} role=${MY_ROLE}`);
}


// ─────────────────────────────────────────────────────────────────────────────
// REGISTRAZIONE HANDLER
// ─────────────────────────────────────────────────────────────────────────────

/** Registra un callback per un tipo di messaggio. cb(payload, fromId) */
export function onTeamMessage(type, cb) {
    if (!_handlers.has(type)) _handlers.set(type, []);
    _handlers.get(type).push(cb);
}


// ─────────────────────────────────────────────────────────────────────────────
// INVIO
// ─────────────────────────────────────────────────────────────────────────────

/** Manda a tutti gli alleati (shout filtrato per team) */
export function broadcast(type, payload) {
    if (!_socket) return;
    _socket.emitShout({ teamId: TEAM_ID, type, payload });
}

/** Manda a un alleato specifico */
export function sendTo(teammateId, type, payload) {
    if (!_socket) return;
    _socket.emitSay(teammateId, { teamId: TEAM_ID, type, payload });
}

/**
 * Manda una domanda e aspetta la risposta (con timeout).
 * L'alleato risponde tramite l'handler registrato su `type`.
 */
export function askTeammate(teammateId, type, payload, timeoutMs = 2000) {
    return new Promise((resolve) => {
        if (!_socket) return resolve(null);
        const askId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        _pendingAsks.set(askId, resolve);
        _socket.emitSay(teammateId, {
            teamId: TEAM_ID, type: '__ask__', innerType: type, askId, payload,
        });
        setTimeout(() => {
            if (_pendingAsks.has(askId)) { _pendingAsks.delete(askId); resolve(null); }
        }, timeoutMs);
    });
}


// ─────────────────────────────────────────────────────────────────────────────
// HELPER DI ALTO LIVELLO — scambio di beliefs
// ─────────────────────────────────────────────────────────────────────────────

/** Condivide pacchi e nemici visti con il team. Chiamala dopo updateSensing(). */
export function shareBeliefs(beliefs) {
    broadcast('parcels_update', {
        parcels: [...beliefs.parcels.values()].map(p => ({
            id: p.id, x: p.x, y: p.y, reward: p.reward, carriedBy: p.carriedBy,
        })),
        me: { x: beliefs.me.x, y: beliefs.me.y, id: beliefs.me.id },
    });
}

/** Lista degli id degli alleati confermati */
export function getTeammates() {
    return [...new Set(_teammates)];
}

export { TEAM_ID, MY_ROLE };
