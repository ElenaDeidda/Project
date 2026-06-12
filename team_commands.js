// team_commands.js
// ─────────────────────────────────────────────────────────────────────────────
// Lato BDI del protocollo di squadra (L3). Il BDI resta un BDI puro: questo
// modulo si limita a tradurre i messaggi del compagno (l'agente LLM) in goal:
//   {action:'goto', x, y, hold}  → vai a (x,y); se hold, resta fermo dopo
//   {action:'hold'}              → fermati e aspetta
//   {action:'resume'}            → riprendi il gioco normale
//   {action:'pickup'}            → raccogli qui
//   {action:'deliver'}           → porta tutto alla delivery più vicina
// Ogni comando completato risponde con 'cmd_done' {action, ok, x, y}.
// I comandi arrivano via communication.js → sono già filtrati per teamId,
// quindi solo il compagno di squadra può impartirli.
//
// USO (in main.js, dopo che onYou ha popolato beliefs.me.teamId):
//   const team = initTeamCommands(socket, agent, beliefs);
//   ...nel loop BDI: if (!team.isHeld()) agent.push(...)
// ─────────────────────────────────────────────────────────────────────────────

import { initComms, onTeamMessage, sendTo } from './communication.js';
import { navigateTo } from './moves.js';

export function initTeamCommands(socket, agent, beliefs) {
    initComms(socket, beliefs);

    let held = false;           // true → il loop BDI non pusha intenzioni
    let chain = Promise.resolve();   // serializza i comandi (uno alla volta)

    const me = () => `(${Math.round(beliefs.me.x)},${Math.round(beliefs.me.y)})`;

    function hold() {
        if (!held) console.log(`[TEAM] ⏸ hold — BDI fermo @ ${me()}`);
        held = true;
        agent.stop();           // interrompe l'intenzione in corso
    }
    function resume() {
        if (held) console.log(`[TEAM] ▶ resume — BDI riprende`);
        held = false;
    }

    async function runCommand(payload, from) {
        const done = (extra = {}) =>
            sendTo(from, 'cmd_done', { action: payload.action, ok: true,
                                       x: Math.round(beliefs.me.x), y: Math.round(beliefs.me.y), ...extra });
        const fail = (why) => {
            console.warn(`[TEAM] comando ${payload.action} fallito: ${why}`);
            sendTo(from, 'cmd_done', { action: payload.action, ok: false, why });
        };

        switch (payload.action) {
            case 'hold':   hold();   return done();
            case 'resume': resume(); return done();

            case 'goto': {
                const { x, y } = payload;
                if (!Number.isFinite(x) || !Number.isFinite(y)) return fail('coordinate non valide');
                hold();
                console.log(`[TEAM] goto (${x},${y}) su ordine del compagno`);
                const nav = await navigateTo(beliefs.me, { x, y }, socket, beliefs.mapTiles);
                if (nav === 'failed') { resume(); return fail(`(${x},${y}) irraggiungibile`); }
                if (!payload.hold) resume();   // hold=true → resto fermo fino a 'resume'
                return done();
            }

            case 'pickup': {
                const picked = await socket.emitPickup();
                if (picked && picked.length > 0) {
                    beliefs.carrying       = true;
                    beliefs.carriedParcels = [...beliefs.carriedParcels, ...picked];
                }
                console.log(`[TEAM] pickup su ordine: ${picked?.length ?? 0} pacchi @ ${me()}`);
                return done({ picked: picked?.map(p => p.id) ?? [] });
            }

            case 'deliver': {
                const dps = beliefs.deliveryPoints ?? [];
                if (dps.length === 0) return fail('nessuna delivery nota');
                const d = dps.reduce((best, t) =>
                    (Math.abs(t.x - beliefs.me.x) + Math.abs(t.y - beliefs.me.y)) <
                    (Math.abs(best.x - beliefs.me.x) + Math.abs(best.y - beliefs.me.y)) ? t : best);
                hold();
                console.log(`[TEAM] deliver su ordine → (${d.x},${d.y})`);
                const nav = await navigateTo(beliefs.me, d, socket, beliefs.mapTiles);
                if (nav === 'failed') { resume(); return fail('delivery irraggiungibile'); }
                const ids = (beliefs.carriedParcels ?? []).map(p => p.id);
                const dropped = await socket.emitPutdown(ids.length ? ids : undefined);
                beliefs.carrying       = false;
                beliefs.carriedParcels = [];
                if (!payload.hold) resume();
                return done({ delivered: dropped?.length ?? 0 });
            }

            default:
                return fail(`azione sconosciuta "${payload.action}"`);
        }
    }

    // I comandi vengono accodati: se il compagno ne manda due, il secondo
    // parte quando il primo è finito (niente navigazioni sovrapposte).
    onTeamMessage('cmd', (payload, from) => {
        chain = chain
            .then(() => runCommand(payload ?? {}, from))
            .catch(e => console.warn(`[TEAM] errore comando: ${e?.message ?? e}`));
    });

    // Posizione on-demand (askTeammate('where_are_you') dal lato LLM)
    onTeamMessage('where_are_you', () =>
        ({ x: Math.round(beliefs.me.x), y: Math.round(beliefs.me.y) }));

    // Ping/pong: serve all'agente LLM per scoprire il mio id se l'handshake
    // 'hello' iniziale è andato perso (es. processi avviati in tempi diversi).
    onTeamMessage('ping', (_, from) => sendTo(from, 'pong', {}));

    return { isHeld: () => held };
}
