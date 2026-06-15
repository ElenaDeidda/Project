// communication.js
// Canale di comunicazione tra l'agente BDI e l'agente LLM dello stesso team.
// Il teamId è letto dai beliefs (popolato dal server in onYou), così non serve
// hardcodarlo nel .env. Messaggi con teamId diverso vengono scartati.
//
// USO:
//   import { initComms, shareBeliefs, onTeamMessage, askTeammate } from './communication.js';
//   initComms(socket, beliefs);   // chiamare DOPO che onYou ha popolato beliefs.me.teamId
//   onTeamMessage('parcels_update', (payload, from) => { ...aggiorna beliefs... });
//   shareBeliefs(beliefs);

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

// Allowlist di NOMI di compagni (env TEAM_NAMES="elena,lara"), letta a runtime in
// initComms. Serve quando i due agenti hanno teamId DIVERSI (token di team diversi):
// in quel caso il compagno viene riconosciuto per NOME invece che per teamId.
let _allowedNames = new Set();

// teamId corrente — letto dinamicamente per evitare snapshot stantii nei messaggi
function teamId() {
    return _beliefs?.me?.teamId || '';
}

// È un messaggio di un mio compagno? Accetta se coincide il teamId OPPURE se il
// nome del mittente è nell'allowlist TEAM_NAMES (e non sono io stesso).
function isFromTeammate(senderName, msg) {
    if (!msg || typeof msg !== 'object') return false;
    const myTeam = teamId();
    if (myTeam && msg.teamId === myTeam) return true;            // stessa squadra
    const sn = String(senderName || '').toLowerCase();
    const my = String(_beliefs?.me?.name || '').toLowerCase();
    return _allowedNames.size > 0 && sn !== my && _allowedNames.has(sn); // stesso nome-team
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
        console.warn('[COMMS] beliefs.me.teamId vuoto — initComms va chiamato dopo onYou');
    }

    // Tutti i messaggi del team passano da qui
    socket.onMsg((id, name, msg, reply) => {
        const mine = isFromTeammate(name, msg);

        // DEBUG: traccia i messaggi di coordinamento (oggetti con .type), così si
        // vede SE e COSA arriva — anche quelli scartati.
        if (msg && typeof msg === 'object' && msg.type) {
            if (mine) {
                const how = (teamId() && msg.teamId === teamId()) ? 'team' : 'nome';
                dbg(`✓ ricevuto '${msg.type}' da ${name}(${id}) [match: ${how}]`);
            } else {
                dbg(`✗ ricevuto '${msg.type}' da ${name}(${id}) team=${msg.teamId} (mio=${teamId() || '∅'}) e nome non in TEAM_NAMES → scartato`);
            }
        }

        // Scarta i messaggi che non sono di un compagno
        if (!mine) return;

        // Registra l'alleato (log solo alla PRIMA scoperta)
        if (id && !_teammates.has(id)) {
            _teammates.add(id);
            dbg(`🤝 alleato scoperto: ${name}(${id})${msg.type === 'hello' ? ` role=${msg.payload?.role}` : ''}`);
        }

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
            reply({ teamId: teamId(), type: '__reply__', askId: msg.askId, payload: answer });
            return;
        }

        // Messaggio normale → invoca tutti gli handler registrati
        const cbs = _handlers.get(msg.type) || [];
        for (const cb of cbs) cb(msg.payload, id);
    });

    // Handshake iniziale: annuncio la mia presenza al team
    socket.emitShout({ teamId: teamId(), type: 'hello', payload: { role: MY_ROLE } });
    const names = _allowedNames.size ? [..._allowedNames].join(',') : '(nessuno → solo teamId)';
    dbg(`inizializzato — team=${teamId() || '??'} role=${MY_ROLE} | TEAM_NAMES=${names} → inviato 'hello'`);
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
    if (!_socket) { dbg(`⚠ broadcast '${type}' ignorato: socket non inizializzato`); return; }
    dbg(`→ broadcast '${type}' (team=${teamId() || '??'})`);
    _socket.emitShout({ teamId: teamId(), type, payload });
}

/** Manda a un alleato specifico */
export function sendTo(teammateId, type, payload) {
    if (!_socket) { dbg(`⚠ sendTo '${type}' ignorato: socket non inizializzato`); return; }
    dbg(`→ sendTo ${teammateId} '${type}'`);
    _socket.emitSay(teammateId, { teamId: teamId(), type, payload });
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
            teamId: teamId(), type: '__ask__', innerType: type, askId, payload,
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

export { MY_ROLE };
