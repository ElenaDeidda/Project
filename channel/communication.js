// communication.js
// Canale di comunicazione tra l'agente BDI e l'agente LLM dello stesso team.
// Il teamId e letto dai beliefs (popolato dal server in onYou); messaggi con
// teamId diverso vengono scartati. initComms() va chiamato DOPO onYou.

const MY_ROLE = process.env.ROLE || 'peer'; // 'bdi' | 'llm' | 'peer'

// Log del traffico di team: ON di default, silenziabile con COMMS_DEBUG=false.
// Prefisso col NOME dell'agente (quando disponibile) per distinguere i 2 processi.
const COMMS_DEBUG = process.env.COMMS_DEBUG !== 'false';
function dbg(m) { if (COMMS_DEBUG) console.log(`[COMMS:${_beliefs?.me?.name || MY_ROLE}] ${m}`); }

let _socket   = null;
let _beliefs  = null;                 // riferimento ai beliefs per leggere teamId on-the-fly
const _handlers    = new Map();       // type -> [callback]
const _teammates   = new Set();       // id degli alleati confermati
const _pendingAsks = new Map();       // askId -> resolve()

// Allowlist opzionale di nomi via env TEAM_NAMES="elena,lara": ripiego se i
// teamName non combaciano (di norma il riconoscimento e automatico).
let _allowedNames = new Set();

// teamId / teamName correnti, letti dinamicamente.
function teamId()   { return _beliefs?.me?.teamId   || ''; }
function teamName() { return _beliefs?.me?.teamName || ''; }

// Busta standard di ogni messaggio: porta sempre teamId e teamName.
function envelope(fields) { return { teamId: teamId(), teamName: teamName(), ...fields }; }

// Il messaggio viene da un compagno? Match per teamName, poi teamId, poi allowlist.
function isFromTeammate(senderName, msg) {
    if (!msg || typeof msg !== 'object') return false;
    const myName = String(_beliefs?.me?.name || '').toLowerCase();
    const sn     = String(senderName || '').toLowerCase();
    if (sn && sn === myName) return false;                       // non sono io stesso
    if (teamName() && msg.teamName === teamName()) return true;  // stesso teamName (auto)
    if (teamId()   && msg.teamId   === teamId())   return true;  // stesso teamId
    return _allowedNames.size > 0 && _allowedNames.has(sn);      // override .env opzionale
}


// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────

export function initComms(socket, beliefs) {
    _socket  = socket;
    _beliefs = beliefs;
    _allowedNames = new Set(
        (process.env.TEAM_NAMES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    );

    if (!teamId()) {
        console.warn('[COMMS] beliefs.me.teamId vuoto - initComms va chiamato dopo onYou');
    }

    // Tutti i messaggi del team passano da qui
    socket.onMsg((id, name, msg, reply) => {
        const mine = isFromTeammate(name, msg);

        // DEBUG: traccia i messaggi di coordinamento (oggetti con .type), cosi si
        // vede SE e COSA arriva - anche quelli scartati.
        if (msg && typeof msg === 'object' && msg.type) {
            if (mine) {
                const how = (teamName() && msg.teamName === teamName()) ? 'teamName'
                          : (teamId() && msg.teamId === teamId()) ? 'teamId' : 'nome';
                dbg(`OK ricevuto '${msg.type}' da ${name}(${id}) [match: ${how}]`);
            } else {
                dbg(`X ricevuto '${msg.type}' da ${name}(${id}) teamName='${msg.teamName ?? ''}' (mio='${teamName()}') -> non e' un compagno, scartato`);
            }
        }

        // Scarta i messaggi che non sono di un compagno
        if (!mine) return;

        // Registra l'alleato (log solo alla PRIMA scoperta)
        if (id && !_teammates.has(id)) {
            _teammates.add(id);
            dbg(`[MATE] alleato scoperto: ${name}(${id})${msg.type === 'hello' ? ` role=${msg.payload?.role}` : ''}`);
        }

        // Risposta a una ask in sospeso
        if (msg.type === '__reply__' && _pendingAsks.has(msg.askId)) {
            _pendingAsks.get(msg.askId)(msg.payload);
            _pendingAsks.delete(msg.askId);
            return;
        }

        // Se e una ask, e ho un handler che ritorna qualcosa -> rispondo
        if (msg.type === '__ask__' && typeof reply === 'function') {
            const handler = _handlers.get(msg.innerType)?.[0];
            const answer  = handler ? handler(msg.payload, id) : null;
            reply(envelope({ type: '__reply__', askId: msg.askId, payload: answer }));
            return;
        }

        // Messaggio normale -> invoca tutti gli handler registrati
        const cbs = _handlers.get(msg.type) || [];
        for (const cb of cbs) cb(msg.payload, id);
    });

    // Handshake iniziale: shout di 'hello' col mio teamName, cosi chi ha lo stesso
    // teamName mi riconosce come compagno e mi salva (poi si parla in privato).
    socket.emitShout(envelope({ type: 'hello', payload: { role: MY_ROLE, teamName: teamName() } }));
    dbg(`inizializzato - teamName='${teamName()}' teamId=${teamId() || '??'} role=${MY_ROLE} -> shout 'hello'`);
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

/**
 * Manda a TUTTI gli alleati noti, in modo PRIVATO (emitSay diretto a ciascuno):
 * gli altri giocatori NON vedono il messaggio. Se non conosco ancora nessun
 * alleato (handshake non completato) ripiego sullo shout, cosi il primo
 * messaggio non va perso (di fatto succede solo prima dell'hello reciproco).
 */
export function broadcast(type, payload) {
    if (!_socket) { dbg(`[WARN] broadcast '${type}' ignorato: socket non inizializzato`); return; }
    const mates = [..._teammates];
    if (mates.length === 0) {
        dbg(`-> shout '${type}' (nessun alleato noto ancora: fallback visibile)`);
        _socket.emitShout(envelope({ type, payload }));
        return;
    }
    dbg(`-> '${type}' privato a ${mates.length} alleato/i`);
    for (const id of mates) _socket.emitSay(id, envelope({ type, payload }));
}

/** Manda a un alleato specifico */
export function sendTo(teammateId, type, payload) {
    if (!_socket) { dbg(`[WARN] sendTo '${type}' ignorato: socket non inizializzato`); return; }
    dbg(`-> sendTo ${teammateId} '${type}'`);
    _socket.emitSay(teammateId, envelope({ type, payload }));
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
        _socket.emitSay(teammateId, envelope({ type: '__ask__', innerType: type, askId, payload }));
        setTimeout(() => {
            if (_pendingAsks.has(askId)) { _pendingAsks.delete(askId); resolve(null); }
        }, timeoutMs);
    });
}


// ─────────────────────────────────────────────────────────────────────────────
// HELPER DI ALTO LIVELLO - scambio di beliefs
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

export { MY_ROLE };
