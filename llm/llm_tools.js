// llm_tools.js
// Tool registry: ogni tool e una funzione (args) -> string (observation) che
// chiude sul `ctx`. Sottile strato di accesso al mondo / al socket usato dalle
// fasi LLM e dall'executor.

import { snapshotWorld } from './world_state.js';

/**
 * Contesto runtime condiviso, propagato per riferimento a runMission / executeStep / tools.
 * @typedef {Object} AgentCtx
 * @property {Object} socket              socket Deliveroo (DjsConnect)
 * @property {Object} beliefs             beliefs condivisi col BDI
 * @property {Object} deps                piani/dipendenze (navigateTo, activeRules, bdiPause/Resume)
 * @property {string|null} lastSender     mittente dell'ultima missione (per `answer`)
 * @property {string|null} [_lastCalcResult] ultimo risultato di calculate (per `answer: result`)
 */

// ─── TOOLS REGISTRY: ogni tool e (args) -> string (observation) ──────────────

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

        // ── Percezione: snapshot testuale di tutto cio che il BDI sa ────────
        inspect: () => snapshotWorld(beliefs, deps?.activeRules ?? {}),

        // ── Delivery piu vicina a me ────────────────────────────────────────
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
            // Verifica la posizione effettiva: navigateTo puo fermarsi a meta.
            // Se non siamo arrivati -> Error (fa scattare la reflection).
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

        // ── L1: rispondi al mittente della missione (ctx.lastSender) ────────
        answer: (input) => {
            const to = ctx.lastSender;
            if (!to) return 'Error: nessun mittente noto a cui rispondere';
            socket.emitSay(to, { type: 'mission_answer', answer: String(input) });
            return `Risposta inviata a ${to}: ${input}`;
        },

        // ── L2: installa una regola persistente (applicata dal loop BDI) ────
        // Input: JSON {type, ...params}; i tipi sono nello switch sotto.
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
