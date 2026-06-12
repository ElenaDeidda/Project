// llm_agent.js
// Agente LLM (parte 2 del progetto) — interpreta special missions in linguaggio
// naturale e le esegue chiamando i tool del tuo sistema.
//
// Architettura (slide 12 del prof): Memory → Planner → Exec(Tools) → Replan?
// Pattern di esecuzione: ReAct (Thought / Action / Action Input / Observation),
// preso dal lab8.
//
// SCOPE attuale: L1 + L2 (no coordinamento BDI ↔ LLM).
//   - Solo lettura della chat per ricevere missioni (nessun handshake/hello)
//   - Scrittura in chat SOLO via il tool `answer`, quando la missione lo richiede
//
// USO:
//   import { startLlmAgent } from './llm_agent.js';
//   startLlmAgent(socket, beliefs, { navigateTo, getPddlPlan });

import OpenAI from 'openai';
import { initQueue, enqueue } from './mission_queue.js';
import { executeVerdict } from './mission_executor.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. CONFIG LLM — LiteLLM UniTN (come lab8)
// ─────────────────────────────────────────────────────────────────────────────

const baseURL = process.env.LITELLM_BASE_URL || 'https://llm.bears.disi.unitn.it/v1';
const apiKey  = process.env.LITELLM_API_KEY;
const MODEL   = process.env.LOCAL_MODEL || 'llama-3.3-70b-lmstudio';

// Temperatura del modello (0 = deterministico ma rigido; 0.2-0.3 = poco esplorativo
// ma riesce a uscire da loop quando un tool fallisce). Override con LLM_TEMP nel .env.
const TEMP    = Number(process.env.LLM_TEMP ?? 0.2);

if (!apiKey) {
    // console.error('[LLM] Manca LITELLM_API_KEY nel .env');
    process.exit(1);
}

const client = new OpenAI({ baseURL, apiKey });

const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 30000);

// Timeout esplicito: se l'API resta appesa (server lento, VPN traballante),
// non vogliamo che il loop ReAct si pianti per minuti. Throw → il loop
// gestisce l'errore come "formato non valido" e prova ancora.
async function callModel(messages, { temperature = TEMP, timeoutMs = LLM_TIMEOUT_MS } = {}) {
    return await Promise.race([
        client.chat.completions.create({ model: MODEL, messages, temperature })
            .then(r => r.choices?.[0]?.message?.content ?? ''),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`LLM timeout ${timeoutMs}ms`)), timeoutMs)
        ),
    ]);
}


// ─────────────────────────────────────────────────────────────────────────────
// SNAPSHOT DEL MONDO — usato dal tool `inspect`
// Espone tutti i beliefs in forma testuale compatta. Quello che conosce il
// BDI lo conosce anche l'LLM. Se aggiungi un campo ai beliefs e lo vuoi
// visibile all'LLM, aggiungilo qui.
// ─────────────────────────────────────────────────────────────────────────────

function snapshotWorld(beliefs, activeRules = {}) {
    const me = beliefs.me ?? {};
    const lines = [];

    // Identità + stato
    lines.push(`me: id=${me.id} name=${me.name} team=${me.teamName}(${me.teamId})`);
    lines.push(`position: x=${Math.round(me.x)} y=${Math.round(me.y)} score=${me.score ?? '?'}`);

    // Carico
    const carried = beliefs.carriedParcels ?? [];
    if (carried.length === 0) {
        lines.push('carrying: none');
    } else {
        lines.push(`carrying: ${carried.length} parcels [${
            carried.map(p => `${p.id}(reward=${p.reward})`).join(', ')
        }]`);
    }

    // Mappa: bordi e tipo
    const mapTiles = beliefs.mapTiles ?? new Map();
    if (mapTiles.size > 0) {
        const xs = [], ys = [];
        for (const k of mapTiles.keys()) {
            const [x, y] = k.split('_').map(Number);
            xs.push(x); ys.push(y);
        }
        lines.push(`map_bounds: xmin=${Math.min(...xs)} xmax=${Math.max(...xs)} ymin=${Math.min(...ys)} ymax=${Math.max(...ys)} tiles=${mapTiles.size} directional=${!!beliefs.isDirectionalMap}`);
    } else {
        lines.push('map_bounds: not loaded');
    }

    // Delivery points
    const dps = beliefs.deliveryPoints ?? [];
    lines.push(`delivery_points (${dps.length}) [drop parcels HERE to score]: ${
        dps.length ? dps.map(d => `(${d.x},${d.y})`).join(' ') : 'none'
    }`);

    // Spawn-rich tiles: dove i pacchi possono apparire. NON sono delivery!
    // Espone i top-N per visibilità (= quante spawn tiles si vedono da lì):
    // sono i posti migliori dove andare/aspettare per trovare pacchi.
    const spawnVis = beliefs.spawnVisibility ?? new Map();
    if (spawnVis.size > 0) {
        const top = [...spawnVis.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);
        const list = top.map(([key, vis]) => {
            const [x, y] = key.split('_').map(Number);
            return `(${x},${y}) vis=${vis}`;
        }).join(' ');
        lines.push(`top_spawn_tiles (${spawnVis.size} total) [parcels APPEAR here]: ${list}`);
    }

    // Pacchi visibili
    const parcels = [...(beliefs.parcels?.values() ?? [])];
    const free    = parcels.filter(p => !p.carriedBy);
    if (free.length === 0) {
        lines.push('visible_free_parcels: none');
    } else {
        lines.push(`visible_free_parcels (${free.length}):`);
        for (const p of free) {
            lines.push(`  id=${p.id} at=(${Math.round(p.x)},${Math.round(p.y)}) reward=${Math.round(p.reward)}`);
        }
    }

    // Agenti visibili (nemici / altri). Saltiamo i "phantom" usati internamente
    // per implementare forbidden_tile (chiave che inizia con __forbidden_).
    const agentEntries = [...(beliefs.agents?.entries() ?? [])]
        .filter(([k]) => !String(k).startsWith('__forbidden_'));
    if (agentEntries.length === 0) {
        lines.push('visible_agents: none');
    } else {
        lines.push(`visible_agents (${agentEntries.length}):`);
        for (const [, a] of agentEntries) {
            lines.push(`  at=(${Math.round(a.x)},${Math.round(a.y)}) moving=${a.moving} dir=${a.direction}`);
        }
    }

    // Regole L2 attive (così l'LLM sa cosa ha già installato)
    const ruleKeys = Object.keys(activeRules);
    if (ruleKeys.length > 0) {
        lines.push(`active_rules: ${JSON.stringify(activeRules)}`);
    } else {
        lines.push('active_rules: none');
    }

    // Config rilevante per le decisioni
    const cfg = beliefs.config?.GAME ?? {};
    const cfgBits = [];
    if (cfg.player?.capacity            != null) cfgBits.push(`capacity=${cfg.player.capacity}`);
    if (cfg.player?.observation_distance!= null) cfgBits.push(`obs_dist=${cfg.player.observation_distance}`);
    if (cfg.player?.movement_duration   != null) cfgBits.push(`move_ms=${cfg.player.movement_duration}`);
    if (cfg.parcels?.decaying_event     != null) cfgBits.push(`decay=${cfg.parcels.decaying_event}`);
    if (cfg.parcels?.reward_avg         != null) cfgBits.push(`reward_avg=${cfg.parcels.reward_avg}`);
    if (cfgBits.length) lines.push(`game_config: ${cfgBits.join(' ')}`);

    return lines.join('\n');
}


// ─────────────────────────────────────────────────────────────────────────────
// 2. TOOLS REGISTRY
//    Ogni tool è una funzione async (args, ctx) → string (observation).
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

        // ── Quick-win: la delivery più vicina a me ──────────────────────────
        // Evita all'LLM il calcolo ripetuto delle distanze. Utile per
        // missioni tipo "vai alla delivery più vicina".
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
            return res === 'failed' ? `Error: irraggiungibile (${target.x},${target.y})`
                                    : `Arrivato a (${target.x},${target.y})`;
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
        // ctx.lastSender è popolato in startLlmAgent al momento di onMsg.
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
        //     → consegna solo quando porti esattamente 3 pacchi
        //   {"type":"forbidden_tile", "x":5, "y":7}
        //     → A* evita la tile (può essere chiamato più volte per più tile)
        //   {"type":"zero_delivery", "x":5, "y":7}
        //     → mai consegnare su questa delivery (ne sceglie un'altra)
        //   {"type":"bonus_delivery", "x":5, "y":7}
        //     → preferisci questa delivery quando possibile
        //   {"type":"max_parcel_reward", "value":10}
        //     → non raccogliere pacchi con reward > 10
        set_rule: (input) => {
            if (!deps?.activeRules) return 'Error: activeRules non disponibile';
            let r;
            try { r = JSON.parse(String(input)); }
            catch (e) { return `Error: input non è JSON valido: ${e.message}`; }
            if (!r || typeof r.type !== 'string') return 'Error: serve {"type": "..."}';
            const rules = deps.activeRules;
            switch (r.type) {
                case 'stack_size':
                    if (!Number.isInteger(r.n) || r.n < 1) return 'Error: stack_size richiede n intero ≥ 1';
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
                default:
                    return `Error: tipo sconosciuto "${r.type}". Validi: stack_size, forbidden_tile, zero_delivery, bonus_delivery, max_parcel_reward`;
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
                stack_size:        'stackSize',
                forbidden_tile:    'forbiddenTiles',
                zero_delivery:     'zeroDeliveries',
                bonus_delivery:    'bonusDeliveries',
                max_parcel_reward: 'maxParcelReward',
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


// ─────────────────────────────────────────────────────────────────────────────
// 3. PROMPT ReAct  (stile lab8)
// ─────────────────────────────────────────────────────────────────────────────

function buildPrompt(toolNames) {
    return `
You are the LLM agent of a Deliveroo team. You receive special missions in natural
language and complete them using ONLY the available tools.

Available tools:
- calculate(expression): evaluates a math expression. e.g. "4*2"
- inspect(): returns a snapshot of the WHOLE world state you know about:
  your position, score, what you are carrying, map bounds, delivery points,
  visible free parcels, visible agents, game config, ACTIVE RULES. Use
  whenever the mission references map features ("leftmost delivery", "the
  nearest parcel", "edge tile", "where am I", "how many parcels do I carry",
  ...). Also use it to check active_rules before installing duplicates.
- nearest_delivery(): returns the delivery point closest to my position,
  with the Manhattan distance. Faster than computing manually from inspect.
- navigate_to(x,y): moves the agent to coordinate x,y
- pickup(): picks up parcels on the current tile
- putdown(): drops carried parcels on the current tile
- answer(text): sends a textual answer back to the agent who sent the mission
  (use for questions like "what is the capital of Italy?")
- set_rule(json): installs a persistent rule that modifies the agent's normal
  pickup/deliver behaviour. Input is a JSON object. Supported rule types:
    {"type":"stack_size",       "n": 3}         → deliver only when carrying
                                                   EXACTLY n parcels
    {"type":"forbidden_tile",   "x": 5, "y": 7} → A* will avoid this tile
                                                   (call multiple times for
                                                   multiple tiles)
    {"type":"zero_delivery",    "x": 5, "y": 7} → never deliver here
    {"type":"bonus_delivery",   "x": 5, "y": 7} → prefer delivering here
    {"type":"max_parcel_reward","value": 10}    → don't pick up parcels with
                                                   reward > value
- clear_rule(name): removes a previously installed rule. Pass "all" to wipe.
- list_rules(): prints the currently installed rules (or "Nessuna").

STRICT OUTPUT FORMAT — choose exactly one:

FORMAT 1 — use one tool:
Thought: <brief reasoning>
Action: <tool name>
Action Input: <input, or "none">

FORMAT 2 — finished:
Thought: I have completed the mission.
Final Answer: <short summary of what you did>

Rules:
- Output exactly ONE action per message. Never two actions together.
- Never output an Action and a Final Answer in the same message.
- Do not invent tool results. Wait for the Observation.
- For arithmetic, ALWAYS use calculate; never compute yourself.
- For missions that reference world features (positions, distances, what you
  carry, delivery points, leftmost/rightmost/edge, nearest parcel, ...) ALWAYS
  call inspect() FIRST to read real values from the world. Never guess.

WORLD MODEL — read carefully:
- delivery_points: tiles where you DROP parcels with putdown() to score points.
  Parcels are NOT generated here. Going to a delivery_point looking for parcels
  is wrong.
- top_spawn_tiles: tiles where the server SPAWNS parcels. To FIND parcels,
  navigate to one of these (the highest vis= score is the best lookout).
- visible_free_parcels: parcels on the ground inside your observation_distance.
  If empty, you can't see any from where you are — move to a top_spawn_tile and
  call inspect() again.

For "pick the nearest parcel and deliver" type missions:
  1. inspect() → look at visible_free_parcels
  2. If empty: navigate_to a top_spawn_tile → inspect() again (parcels may have
     entered your observation range)
  3. Once you see a parcel: navigate_to its (x,y) → pickup()
  4. inspect() → choose the NEAREST delivery_point from your position
  5. navigate_to that delivery → putdown()
- If navigate_to returns "irraggiungibile" twice for the SAME target, the tile
  is truly a wall: stop trying it and produce Final Answer explaining you
  could not reach the destination. Do not try random nearby tiles.

MISSION TYPES — IMPORTANT:
There are THREE families. Always pick the right one based on the mission text.

1) QUESTION / CALCULATION (e.g. "Calcola 5*5", "What is the capital of Italy?",
   "Quanto fa 7+3?"). The server CANNOT see what you "thought" — it only sees
   what you sent via answer(). You MUST end such missions with:
     Action: answer / Action Input: <the final result>
   Only AFTER the answer() Observation, output Final Answer.

2) ATOMIC ACTION (e.g. "Move to (4,7)", "Pick up the parcel at (2,3)",
   "Drop a package in the leftmost tile", "Go to one of (1,2)/(3,4)/(5,6)
   for a bonus"). The server checks the world state, not chat. Do the
   actions (navigate_to, pickup, putdown). No answer() needed. Then
   Final Answer.

   Markers that the mission is ATOMIC (one-shot, not a rule):
     "una tantum", "one-time", "once", "una volta", "this time only",
     "single", "the closest one", "any of", "one of these".

   When the mission lists MULTIPLE candidate coordinates (in brackets,
   in JSON, or as a list) and asks you to reach "one of" them, you must
   pick the CLOSEST one to your current position and navigate there.
   The coordinates can come in different formats — parse them carefully:
     "(1,2)"            → x=1, y=2
     "{\"x\":1,\"y\":2}"  → x=1, y=2
     "[1,2]"            → x=1, y=2
   Example flow for such a mission:
     Step 1: Action: inspect / Action Input: none      (get my position)
     Step 2: Thought: choose the candidate closest to (my.x, my.y)
             Action: navigate_to / Action Input: x,y of the closest one
     Step 3: Final Answer: arrived at (x,y) for the bonus.

3) PERSISTENT RULE — Level 2 (e.g. "Deliver stacks of exactly 3 parcels",
   "Do not go through tile (5,7)", "Every time you deliver in (2,2) you get
   0 points", "If you deliver parcels with reward > 10 you get no reward").
   These DO NOT describe a single action — they CHANGE THE RULES of the game
   for the rest of the match. You MUST translate them into a set_rule() call.
   Markers that the mission IS a rule:
     "every time", "always", "from now on", "for the rest of the game",
     "stacks of", "do not / don't", "if you deliver/pick".
   IMPORTANT: do NOT install a rule when the mission is one-shot. Words like
   "una tantum", "one-time", "once", "this time" mean ATOMIC (family 2).
   Examples of mission → tool call:
     "Deliver in stacks of exactly 3 to double the reward"
        → set_rule({"type":"stack_size","n":3})
     "Do not go through tile (5,7) otherwise you lose 50pts"
        → set_rule({"type":"forbidden_tile","x":5,"y":7})
     "Every time you deliver in (2,2) you get 0 pts"
        → set_rule({"type":"zero_delivery","x":2,"y":2})
     "Every time you deliver in (3,3) or (7,7) you get 5x pts"
        → set_rule({"type":"bonus_delivery","x":3,"y":3})
        → set_rule({"type":"bonus_delivery","x":7,"y":7})
     "If you deliver parcels with reward higher than 10 you get no reward"
        → set_rule({"type":"max_parcel_reward","value":10})
   After installing the rule(s), produce Final Answer immediately. The rule
   will then be enforced automatically by the agent's BDI loop.

For calculation missions, the flow is exactly:
   Step 1: Action: calculate / Action Input: <expression>
   Step 2: (after the Result observation) Action: answer / Action Input: <number>
   Step 3: Final Answer: ...

- Use only the available tools: ${toolNames.join(', ')}.
`.trim();
}

function extractAction(text) {
    const a  = text.match(/^Action:\s*(.+)$/im);
    const ai = text.match(/^Action Input:\s*(.+)$/im);
    if (!a) return null;
    return { action: a[1].trim(), input: ai ? ai[1].trim() : 'none' };
}
function extractFinal(text) {
    const m = text.match(/^Final Answer:\s*([\s\S]*)$/im);
    return m ? m[1].trim() : null;
}


// ─────────────────────────────────────────────────────────────────────────────
// 4. LOOP DI ESECUZIONE DI UNA MISSIONE  (ReAct con limite di iterazioni)
// ─────────────────────────────────────────────────────────────────────────────

const MAX_STEPS = 8;

/**
 * Esegue una missione con il loop ReAct.
 * @param {string} missionText
 * @param {object} ctx        contesto con { socket, beliefs, deps, lastSender }
 * @param {AbortSignal} [signal]   se .aborted=true la missione viene interrotta
 *                                 fra uno step e l'altro (la chiamata LLM in corso
 *                                 viene comunque attesa fino alla fine)
 */
async function runMission(missionText, ctx, signal = null) {
    const tools  = makeTools(ctx);
    const prompt = buildPrompt(Object.keys(tools));

    const messages = [
        { role: 'system', content: prompt },
        { role: 'user',   content: `Mission: ${missionText}` },
    ];

    for (let step = 0; step < MAX_STEPS; step++) {
        if (signal?.aborted) {
            console.log(`[LLM] missione interrotta dalla queue`);
            return null;
        }

        const out = await callModel(messages, { temperature: 0 });
        messages.push({ role: 'assistant', content: out });

        console.log(`[LLM] step ${step + 1} ──────────`);
        console.log(out);

        if (signal?.aborted) {
            console.log(`[LLM] missione interrotta dopo lo step ${step + 1}`);
            return null;
        }

        const final = extractFinal(out);
        if (final) {
            console.log(`[LLM] Missione completata: ${final}`);
            return final;
        }

        const act = extractAction(out);
        if (!act) {
            console.warn('[LLM] formato non valido — chiedo di riprovare');
            messages.push({ role: 'user', content: 'Invalid format. Use Action or Final Answer.' });
            continue;
        }

        const tool = tools[act.action];
        let observation;
        if (!tool) {
            observation = `Error: tool sconosciuto "${act.action}"`;
        } else {
            try {
                observation = await tool(act.input === 'none' ? '' : act.input, ctx);
            } catch (e) {
                observation = `Error: ${e.message}`;
            }
        }

        console.log(`[LLM] ${act.action}(${act.input}) → ${observation}`);
        messages.push({ role: 'user', content: `Observation: ${observation}` });
    }

    console.warn('[LLM] Limite iterazioni raggiunto senza Final Answer');
    return null;
}


// ─────────────────────────────────────────────────────────────────────────────
// FILTRO: messaggi di coordinamento di altri team da scartare in ingresso.
// I team avversari shoutano in chat con loro protocolli ("ASA_COORD v1 ...",
// "[HELLOTEAM]:...", "MAGNAGATTI ...") e finirebbero a saturare la queue come
// finte missioni informative. Le riconosciamo per forma e le ignoriamo.
// ─────────────────────────────────────────────────────────────────────────────
function isProtocolMessage(text) {
    const t = String(text).trim();
    if (!t) return true;
    // Tag tipo [HELLOTEAM]:..., [TEAM_X], [PROTO]
    if (/^\[[A-Z_0-9-]+\]/i.test(t)) return true;
    // PROTOCOLLO v1, NAME_LIKE v2 (token tutto-MAIUSCOLE + "v<n>")
    if (/^[A-Z][A-Z_0-9]{2,}\s+v\d+\b/.test(t)) return true;
    // Inizia con un blob JSON puro (oggetto/array) — non è linguaggio naturale
    if (/^[\{\[]/.test(t)) return true;
    // Prefissi noti di team coord
    if (/^(ASA[_-]?COORD|TEAM[_-]?MSG|MAGNAGATTI|HELLOTEAM|HELLO\s)/i.test(t)) return true;
    return false;
}


// ─────────────────────────────────────────────────────────────────────────────
// 5. ENTRY POINT — collega l'agente al socket e ascolta le special missions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} socket   socket Deliveroo (DjsConnect)
 * @param {object} beliefs  i beliefs condivisi col BDI
 * @param {{navigateTo:Function, getPddlPlan?:Function}} deps  i tuoi piani
 */
export function startLlmAgent(socket, beliefs, deps) {
    // ctx è condiviso tra le missioni: la queue ne aggiorna `lastSender` prima
    // di ogni esecuzione, e il tool `answer` lo legge per rispondere al mittente.
    const ctx = { socket, beliefs, deps, lastSender: null };

    // Bridge: la queue esegue le missioni chiamando questa funzione.
    // Le missioni capite dal parser (question/action/rule) vanno all'executor
    // DETERMINISTICO: zero giri di ReAct, errori → si rinuncia e basta
    // (politica: meglio un bonus perso che punti persi). Il loop ReAct resta
    // solo per il coordinamento L3, in attesa del pezzo 4.
    async function executeMission(text, senderId, signal, verdict) {
        ctx.lastSender = senderId;
        if (verdict && ['question', 'action', 'rule'].includes(verdict.kind)) {
            return await executeVerdict(text, verdict, ctx, signal);
        }
        return await runMission(text, ctx, signal);
    }

    initQueue({
        beliefs,
        runMission: executeMission,
        bdiPause:   deps?.bdiPause,
        bdiResume:  deps?.bdiResume,
    });

    // Ascolto chat: SOLO lettura, nessun handshake.
    // Ogni messaggio plausibile come missione viene messo in coda con priorità.
    socket.onMsg((id, name, msg) => {
        // Una missione è una stringa o un oggetto {mission:'...'} / {text:'...'}.
        // Tutto il resto (payload strutturati interni) viene ignorato.
        let text = null;
        if (typeof msg === 'string') text = msg;
        else if (msg && typeof msg.mission === 'string') text = msg.mission;
        else if (msg && typeof msg.text    === 'string') text = msg.text;
        if (!text) return;

        // Filtro: scarta i messaggi di coordinamento di altri team (i loro
        // agenti shoutano protocolli tipo "ASA_COORD v1 ...", "[HELLOTEAM]:..."
        // — non sono missioni del prof e ci farebbero solo perdere tempo.
        if (isProtocolMessage(text)) {
            console.log(`[LLM] ignoro protocollo da ${name} (${id}): "${text.slice(0, 60)}${text.length>60?'…':''}"`);
            return;
        }

        console.log(`[LLM] Mission da ${name} (${id}): "${text}"`);
        // enqueue è async (fa la chiamata LLM di parsing): fire-and-forget,
        // gli errori finiscono nel log e non bloccano il listener chat.
        enqueue(text, id).catch(e =>
            console.warn(`[LLM] enqueue fallita: ${e?.message ?? e}`));
    });

    console.log('[LLM] Avviato — coda missioni attiva, in ascolto chat');
}
