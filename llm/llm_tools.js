// llm_tools.js
// Tool registry: ogni tool e una funzione (args) -> string (observation) che
// chiude sul `ctx`. Sottile strato di accesso al mondo / al socket usato dalle
// fasi LLM e dall'executor.

import { snapshotWorld } from './world_state.js';

/**
 * Contesto runtime condiviso, creato in startLlmAgent e propagato per
 * riferimento a runMission / executeStep / tools. NON va promosso a singleton
 * di modulo: e il contratto implicito tra tools, executor e runner.
 * @typedef {Object} AgentCtx
 * @property {Object} socket              socket Deliveroo (DjsConnect)
 * @property {Object} beliefs             beliefs condivisi col BDI
 * @property {Object} deps                piani/dipendenze (navigateTo, activeRules, bdiPause/Resume)
 * @property {string|null} lastSender     id del mittente dell'ultima missione (per `answer`)
 * @property {string|null} [_lastCalcResult] ultimo risultato di calculate (per `answer: result`)
 */

// ─────────────────────────────────────────────────────────────────────────────
// TOOLS REGISTRY
//    Ogni tool e una funzione async (args, ctx) -> string (observation).
//    ctx contiene { socket, beliefs, deps } passati a startLlmAgent.
// ─────────────────────────────────────────────────────────────────────────────

function makeTools(ctx) {
    const { socket, beliefs, deps } = ctx;

    return {
        // ── L1: calcolo aritmetico ──────────────────────────────────────────
        calculate: (input) => {
            const clean = String(input).replace(/[^0-9+\-*/()\s.]/g, '');
            try {
                // eslint-disable-next-line no-new-func
                const r = Function(`"use strict"; return (${clean});`)();
                return `Result: ${r}`;
            } catch (e) {
                return `Error: ${e.message}`;
            }
        },

        // ── Tool GENERALE di percezione ─────────────────────────────────────
        // Espone TUTTO quello che il BDI sa nei `beliefs`. L'LLM lo legge e
        // si arrangia: niente tool specifici per ogni tipo di missione.
        // Restituisce uno snapshot testuale compatto ma completo.
        inspect: () => snapshotWorld(beliefs, deps?.activeRules ?? {}),

        // ── Quick-win: la delivery piu vicina a me ──────────────────────────
        // Evita all'LLM il calcolo ripetuto delle distanze. Utile per
        // missioni tipo "vai alla delivery piu vicina".
        nearest_delivery: () => {
            const dps = beliefs.deliveryPoints ?? [];
            if (dps.length === 0) return 'Nessuna delivery tile nota';
            const me = beliefs.me;
            let best = null, bestD = Infinity;
            for (const d of dps) {
                const dist = Math.abs(d.x - me.x) + Math.abs(d.y - me.y);
                if (dist < bestD) { best = d; bestD = dist; }
            }
            return `Nearest delivery: (${best.x},${best.y}) at distance ${bestD}`;
        },

        // ── L1: muovi verso una coordinata (usa A* o PDDL del BDI) ──────────
        navigate_to: async (input) => {
            const m = String(input).match(/(\d+)\s*,\s*(\d+)/);
            if (!m) return 'Error: coordinate non valide (usa "x,y")';
            const target = { x: Number(m[1]), y: Number(m[2]) };
            const res = await deps.navigateTo(
                beliefs.me, target, socket, beliefs.mapTiles, () => false
            );
            // VERIFICA REALE: non fidarti del solo codice di ritorno. navigateTo
            // puo restituire 'stopped' (interrotto) o arrivare solo in parte;
            // confrontiamo la posizione EFFETTIVA col target cosi non dichiariamo
            // un arrivo che non e avvenuto. Se non siamo arrivati -> Error, che
            // fa scattare la reflection invece di un falso "completato".
            const here = { x: Math.round(beliefs.me.x), y: Math.round(beliefs.me.y) };
            if (here.x !== target.x || here.y !== target.y) {
                return `Error: non arrivato a (${target.x},${target.y}) - ora a (${here.x},${here.y}) [navigateTo=${res}]`;
            }
            return `Arrivato a (${target.x},${target.y})`;
        },

        // ── L1: pickup / putdown ─────────────────────────────────────────────
        pickup: async () => {
            const r = await socket.emitPickup();
            return r && r.length ? `Raccolti ${r.length} pacchi` : 'Nessun pacco qui';
        },
        putdown: async () => {
            const r = await socket.emitPutdown();
            return r && r.length ? `Consegnati ${r.length} pacchi` : 'Niente da consegnare';
        },

        // ── L1: rispondi al mittente della missione ─────────────────────────
        // Le missioni-domanda ("capital of Italy?", "calcola 5*5") richiedono
        // di mandare la risposta all'agente che ha inviato il prompt.
        // ctx.lastSender e popolato in startLlmAgent al momento di onMsg.
        answer: (input) => {
            const to = ctx.lastSender;
            if (!to) return 'Error: nessun mittente noto a cui rispondere';
            socket.emitSay(to, { type: 'mission_answer', answer: String(input) });
            return `Risposta inviata a ${to}: ${input}`;
        },

        // ── L2: installa una regola persistente sul gioco ───────────────────
        // Le missioni di livello 2 sono REGOLE che modificano il comportamento
        // di base (es. "consegna in stack di 3"). L'LLM le riconosce e le
        // installa qui. Le regole vengono applicate dal loop BDI in llm_main.js.
        //
        // Input: JSON con {type, ...params}. Tipi supportati:
        //   {"type":"stack_size", "n":3}
        //     -> consegna solo quando porti esattamente 3 pacchi
        //   {"type":"forbidden_tile", "x":5, "y":7}
        //     -> A* evita la tile (puo essere chiamato piu volte per piu tile)
        //   {"type":"zero_delivery", "x":5, "y":7}
        //     -> mai consegnare su questa delivery (ne sceglie un'altra)
        //   {"type":"bonus_delivery", "x":5, "y":7}
        //     -> preferisci questa delivery quando possibile
        //   {"type":"max_parcel_reward", "value":10}
        //     -> non raccogliere pacchi con reward > 10
        set_rule: (input) => {
            if (!deps?.activeRules) return 'Error: activeRules non disponibile';
            let r;
            try { r = JSON.parse(String(input)); }
            catch (e) { return `Error: input non e JSON valido: ${e.message}`; }
            if (!r || typeof r.type !== 'string') return 'Error: serve {"type": "..."}';
            const rules = deps.activeRules;
            switch (r.type) {
                case 'stack_size':
                    if (!Number.isInteger(r.n) || r.n < 1) return 'Error: stack_size richiede n intero >= 1';
                    rules.stackSize = r.n;
                    return `Regola installata: stackSize=${r.n}`;
                case 'forbidden_tile':
                    if (!Number.isInteger(r.x) || !Number.isInteger(r.y)) return 'Error: serve x e y interi';
                    rules.forbiddenTiles = rules.forbiddenTiles || [];
                    if (!rules.forbiddenTiles.some(t => t.x === r.x && t.y === r.y))
                        rules.forbiddenTiles.push({ x: r.x, y: r.y });
                    return `Regola installata: forbidden_tile (${r.x},${r.y})`;
                case 'zero_delivery':
                    if (!Number.isInteger(r.x) || !Number.isInteger(r.y)) return 'Error: serve x e y interi';
                    rules.zeroDeliveries = rules.zeroDeliveries || [];
                    if (!rules.zeroDeliveries.some(t => t.x === r.x && t.y === r.y))
                        rules.zeroDeliveries.push({ x: r.x, y: r.y });
                    return `Regola installata: zero_delivery (${r.x},${r.y})`;
                case 'bonus_delivery':
                    if (!Number.isInteger(r.x) || !Number.isInteger(r.y)) return 'Error: serve x e y interi';
                    rules.bonusDeliveries = rules.bonusDeliveries || [];
                    if (!rules.bonusDeliveries.some(t => t.x === r.x && t.y === r.y))
                        rules.bonusDeliveries.push({ x: r.x, y: r.y });
                    return `Regola installata: bonus_delivery (${r.x},${r.y})`;
                case 'max_parcel_reward':
                    if (typeof r.value !== 'number') return 'Error: serve value numerico';
                    rules.maxParcelReward = r.value;
                    return `Regola installata: maxParcelReward=${r.value}`;
                case 'max_deliver_reward':
                    if (typeof r.value !== 'number') return 'Error: serve value numerico';
                    rules.maxDeliverReward = r.value;
                    return `Regola installata: maxDeliverReward=${r.value}`;
                default:
                    return `Error: tipo sconosciuto "${r.type}". Validi: stack_size, forbidden_tile, zero_delivery, bonus_delivery, max_parcel_reward, max_deliver_reward`;
            }
        },

        // Cancella una regola (o tutte se "all")
        clear_rule: (input) => {
            if (!deps?.activeRules) return 'Error: activeRules non disponibile';
            const name = String(input).trim();
            const rules = deps.activeRules;
            if (name === 'all') {
                for (const k of Object.keys(rules)) delete rules[k];
                return 'Tutte le regole cancellate';
            }
            const map = {
                stack_size:         'stackSize',
                forbidden_tile:     'forbiddenTiles',
                zero_delivery:      'zeroDeliveries',
                bonus_delivery:     'bonusDeliveries',
                max_parcel_reward:  'maxParcelReward',
                max_deliver_reward: 'maxDeliverReward',
            };
            const key = map[name];
            if (!key) return `Error: nome sconosciuto "${name}"`;
            delete rules[key];
            return `Regola cancellata: ${name}`;
        },

        // Lista regole attive (utile per debugging dell'LLM stesso)
        list_rules: () => {
            const rules = deps?.activeRules ?? {};
            const keys = Object.keys(rules);
            if (keys.length === 0) return 'Nessuna regola attiva';
            return JSON.stringify(rules, null, 0);
        },
    };
}

export { makeTools };
