// llm_agent.js
// Agente LLM (parte 2 del progetto) — interpreta special missions in linguaggio
// naturale e le esegue chiamando i tool del tuo sistema.
//
// Architettura (slide 12 del prof): Memory → Planner → Exec(Tools) → Replan?
// Pattern di esecuzione: Planning Decoupled + State-Based Context.
//   FASE 1  generatePlan()   → 1 sola chiamata LLM: produce la sequenza di step
//   FASE 2  execution loop    → esegue gli step con SOLO tool call (0 LLM)
//   FASE 3  reflectOnError()  → chiamata LLM opzionale, SOLO su errore di uno step
// Niente accumulo di history: l'array `messages` resta [system, user] (2 elementi)
// e uno `state` mutabile traccia il progresso → context costante (~400-600 token).
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
import { parseIntervalMs } from './basic_functions.js';
import { extractReward, extractMultiplier } from './mission_evaluator.js';

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
            // VERIFICA REALE: non fidarti del solo codice di ritorno. navigateTo
            // può restituire 'stopped' (interrotto) o arrivare solo in parte;
            // confrontiamo la posizione EFFETTIVA col target così non dichiariamo
            // un arrivo che non è avvenuto. Se non siamo arrivati → Error, che
            // fa scattare la reflection invece di un falso "completato".
            const here = { x: Math.round(beliefs.me.x), y: Math.round(beliefs.me.y) };
            if (here.x !== target.x || here.y !== target.y) {
                return `Error: non arrivato a (${target.x},${target.y}) — ora a (${here.x},${here.y}) [navigateTo=${res}]`;
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

// extractAction: parser dello stile ReAct (Action / Action Input). Non più
// usato dal loop principale (sostituito da Planning Decoupled), ma mantenuto
// per compatibilità / debug di eventuali output in vecchio formato.
function extractAction(text) {
    const a  = text.match(/^Action:\s*(.+)$/im);
    const ai = text.match(/^Action Input:\s*(.+)$/im);
    if (!a) return null;
    return { action: a[1].trim(), input: ai ? ai[1].trim() : 'none' };
}

/**
 * Estrae il final answer dal testo dell'LLM. Cerca "FINAL ANSWER: ...".
 * @returns {string | null}
 */
function extractFinalAnswer(text) {
    const m = String(text || '').match(/^\s*FINAL ANSWER:\s*(.+)$/im);
    return m ? m[1].trim() : null;
}


// ─────────────────────────────────────────────────────────────────────────────
// 4. PLANNING DECOUPLED + STATE-BASED CONTEXT
//
// Invece del loop ReAct (che accumulava tutta la history nei `messages` ad ogni
// step → context da 150 a 2100 token), separiamo PLANNING ed EXECUTION:
//   FASE 1  generatePlan()    → 1 sola chiamata LLM, produce la sequenza di step
//   FASE 2  execution loop     → esegue gli step con SOLO tool call (0 LLM)
//   FASE 3  reflectOnError()   → chiamata LLM opzionale, SOLO quando uno step
//                                fallisce, per correggere il piano da lì in poi
// Il context resta costante (~400-600 token): l'array `messages` è sempre di 2
// elementi [system, user] e lo `state` mutabile traccia il progresso.
// ─────────────────────────────────────────────────────────────────────────────

// Quante volte al massimo proviamo a correggere il piano prima di arrenderci.
// Meglio fallire rapidamente che restare appesi a riflettere all'infinito.
const MAX_REFLECTIONS = 3;


// ── Prompt per il PLANNER (generatePlan) ─────────────────────────────────────
function buildPlannerPrompt() {
    return `
You are the planner of a Deliveroo LLM agent. Given a mission in natural language
and the current world state, break the mission into a SHORT sequence of concrete
steps. Output ONLY the plan — no reasoning, no extra prose.

Each step has the form "action: target". Valid actions:
- inspect: (target: none) re-read the current world state
- calculate: (target: a math expression, e.g. "5*5") evaluate arithmetic
- go_pick_up: (target: "(x,y)" of a parcel, or "nearest") move to a parcel and pick it up
- go_deliver: (target: "(x,y)" of a delivery point, or "nearest") move to a delivery point and drop carried parcels
- navigate_to: (target: "(x,y)") just move to a tile
- set_rule: (target: a JSON object) install a persistent Level-2 rule
- answer: (target: the text to send) reply to the agent that gave the mission

WORLD MODEL:
- delivery_points: tiles where you DROP parcels to score. Parcels do NOT spawn here.
- top_spawn_tiles: tiles where parcels appear. To FIND parcels, go to one of these.
- visible_free_parcels: parcels currently on the ground that you can see.

MISSION FAMILIES — pick the right one based on the mission text:
1) QUESTION / CALCULATION ("Calcola 5*5", "What is the capital of Italy?"). The
   giver only sees what you send via answer. For arithmetic, add a calculate step
   FIRST, then an answer step whose target is "result" (the computed value is sent
   automatically). For factual questions, a single answer step with the answer text.
     e.g.  1. calculate: 5*5
           2. answer: result
     e.g.  1. answer: Rome
2) ATOMIC ACTION ("pick up the parcel at (2,3) and deliver it", "move to (4,7)",
   "go to one of (1,2)/(3,4) for a bonus"). Use go_pick_up / go_deliver /
   navigate_to with explicit coordinates taken from the mission or the world state.
   When several candidate coordinates are offered, choose the one closest to your
   current position. No answer needed.
     e.g.  1. go_pick_up: (2,3)
           2. go_deliver: nearest
3) PERSISTENT RULE — Level 2 ("deliver stacks of 3", "don't cross tile (5,7)",
   "every time you deliver in (2,2) you get 0 pts", "reward > 10 gives nothing").
   Translate into ONE set_rule step per rule. Supported JSON:
     {"type":"stack_size","n":3}
     {"type":"forbidden_tile","x":5,"y":7}
     {"type":"zero_delivery","x":2,"y":2}
     {"type":"bonus_delivery","x":3,"y":3}
     {"type":"max_parcel_reward","value":10}
     e.g.  1. set_rule: {"type":"stack_size","n":3}

If the mission references parcels you cannot currently see in visible_free_parcels,
add a navigate_to a top_spawn_tile step before go_pick_up, or use "go_pick_up: nearest".

Output EXACTLY this format and nothing else:
PLAN:
1. action: target
2. action: target
FINAL ANSWER: one short line summarising the plan
`.trim();
}


// ── Prompt per il REPLANNER (reflectOnError) ─────────────────────────────────
function buildReplannerPrompt() {
    return `
You are the replanner of a Deliveroo LLM agent. One step of the current plan
failed. Produce a REVISED plan for the REMAINING steps only (from the failed step
onwards). Do NOT repeat the steps that already succeeded.

Use the same actions and JSON rule formats as the planner:
inspect, calculate, go_pick_up, go_deliver, navigate_to, set_rule, answer.

Common fixes:
- go_pick_up failed with "no parcel": navigate_to a top_spawn_tile, then
  "go_pick_up: nearest" (a parcel may enter observation range).
- navigate_to "irraggiungibile": that tile is a wall — choose a different
  reachable target, or answer that the destination cannot be reached.
- the target had no coordinates: read the world state and use real coordinates.

Output EXACTLY this format and nothing else:
PLAN:
1. action: target
2. action: target
FINAL ANSWER: one short line
`.trim();
}


// ── Parsing del piano ────────────────────────────────────────────────────────

/**
 * Estrae il piano dal testo dell'LLM. Tollerante alle variazioni di formato:
 * accetta "1. action: target", "1) action: target", "Step 1: action: target",
 * "- action: target". Isola la sezione dopo un header "PLAN:" (se presente) e
 * ignora la coda "FINAL ANSWER: ...".
 * @returns {Array<{action: string, target: string, description: string}>}
 */
function parsePlan(llmText, startIndex = 0) {  // eslint-disable-line no-unused-vars
    const text = String(llmText || '');

    // Isola il corpo del piano: preferisci ciò che segue un header "PLAN..:".
    let body = text;
    const planMatch = text.match(/PLAN[^\n]*\n([\s\S]*?)(?:\n\s*FINAL ANSWER:|$)/i);
    if (planMatch) {
        body = planMatch[1];
    } else {
        const fa = text.search(/\n\s*FINAL ANSWER:/i);
        if (fa >= 0) body = text.slice(0, fa);
    }

    const steps = [];
    for (const rawLine of body.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        // "1. ...", "1) ...", "1: ...", "Step 1 - ...", oppure bullet "- ..."/"* ..."
        const m = line.match(/^(?:step\s*)?\d+\s*[.):\-]\s*(.+)$/i)
               || line.match(/^[-*]\s+(.+)$/);
        if (!m) continue;
        const step = parseStepContent(m[1].trim());
        if (step) steps.push(step);
    }
    return steps;
}

// Spezza "action: target" (o "action target") in {action, target, description}.
function parseStepContent(content) {
    let action, target;
    const colon = content.indexOf(':');
    if (colon >= 0) {
        action = content.slice(0, colon).trim();
        target = content.slice(colon + 1).trim();
    } else {
        const sp = content.search(/\s/);
        if (sp >= 0) { action = content.slice(0, sp); target = content.slice(sp + 1).trim(); }
        else         { action = content; target = ''; }
    }
    if (!action) return null;
    return { action, target, description: content };
}

// Normalizza il nome azione: minuscolo, separatori → "_", via i caratteri di
// markdown (** `` ecc.). "Go Pick Up" / "**go_pick_up**" → "go_pick_up".
function normalizeAction(a) {
    return String(a).trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');
}

// Il target di un passo "answer" è un segnaposto che rimanda al risultato di un
// calculate precedente? (così non "inventiamo" il numero: lo prendiamo dal tool)
function isResultPlaceholder(t) {
    const s = String(t).trim().toLowerCase();
    return s === '' || /^<.*>$/.test(s) || /\b(result|risultato|computed|above|previous)\b/.test(s);
}

// Estrae "(x,y)" da una stringa target. Null se non ci sono coordinate.
function parseCoords(s) {
    const m = String(s).match(/\(?\s*(-?\d+)\s*,\s*(-?\d+)\s*\)?/);
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

// Pacco libero visibile più vicino a me (null se non se ne vedono).
function nearestFreeParcel(beliefs) {
    const free = [...(beliefs.parcels?.values() ?? [])].filter(p => !p.carriedBy);
    if (free.length === 0) return null;
    const me = beliefs.me ?? { x: 0, y: 0 };
    free.sort((a, b) =>
        (Math.abs(a.x - me.x) + Math.abs(a.y - me.y)) -
        (Math.abs(b.x - me.x) + Math.abs(b.y - me.y)));
    return free[0];
}

// Delivery point più vicino a me (null se non ne conosco).
function nearestDelivery(beliefs) {
    const dps = beliefs.deliveryPoints ?? [];
    if (dps.length === 0) return null;
    const me = beliefs.me ?? { x: 0, y: 0 };
    let best = null, bestD = Infinity;
    for (const d of dps) {
        const dist = Math.abs(d.x - me.x) + Math.abs(d.y - me.y);
        if (dist < bestD) { best = d; bestD = dist; }
    }
    return best;
}


// ── ACQUIRE PERSISTENTE: parametri (allineati al patrol del BDI in options.js) ─
const ACQUIRE_WAIT_FACTOR   = 2;        // attesa per spawn tile = factor × intervallo di generazione
const ACQUIRE_WAIT_FALLBACK = 4000;     // ms, se l'intervallo di generazione non è leggibile
const ACQUIRE_POLL_MS       = 250;      // ogni quanto ri-controllo beliefs.parcels mentre attendo
// Tetto massimo complessivo della ricerca. 0 = nessun tetto: cerca finché non
// trova un pacco o finché la coda interrompe la missione (default voluto dalla
// missione "portala a termine a prescindere"). Override con ACQUIRE_MAX_MS.
const ACQUIRE_MAX_MS        = Number(process.env.ACQUIRE_MAX_MS) || 0;

// Distanza di osservazione corrente (default 5 come da SDK).
function obsDistOf(beliefs) {
    return beliefs.config?.GAME?.player?.observation_distance ?? 5;
}

// Pacco libero ATTUALMENTE VISIBILE (entro obs_distance) più vicino a me.
// A differenza di nearestFreeParcel, ignora i pacchi solo "ricordati" fuori
// vista (fantasmi): inseguirli porta a "Nessun pacco qui".
function nearestVisibleParcel(beliefs) {
    const me  = beliefs.me ?? { x: 0, y: 0 };
    const obs = obsDistOf(beliefs);
    const visible = [...(beliefs.parcels?.values() ?? [])]
        .filter(p => !p.carriedBy)
        .filter(p => (Math.abs(p.x - me.x) + Math.abs(p.y - me.y)) <= obs);
    if (visible.length === 0) return null;
    visible.sort((a, b) =>
        (Math.abs(a.x - me.x) + Math.abs(a.y - me.y)) -
        (Math.abs(b.x - me.x) + Math.abs(b.y - me.y)));
    return visible[0];
}

// Spawn tile "migliore": alta visibilità, vicina a me. Dove ANDARE a cercare
// pacchi quando non se ne vede nessuno (invece di inseguire fantasmi).
function bestSpawnTile(beliefs) {
    const spawnVis = beliefs.spawnVisibility ?? new Map();
    if (spawnVis.size === 0) return null;
    const me = beliefs.me ?? { x: 0, y: 0 };
    let best = null, bestScore = -Infinity;
    for (const [key, vis] of spawnVis.entries()) {
        const [x, y] = key.split('_').map(Number);
        const score = vis * 10 - (Math.abs(x - me.x) + Math.abs(y - me.y));
        if (score > bestScore) { best = { x, y }; bestScore = score; }
    }
    return best;
}

// Tutte le spawn tile ordinate best-first (stesso score di bestSpawnTile). Serve
// per RUOTARE tra le tile invece di martellare sempre la stessa quando è vuota.
function rankedSpawnTiles(beliefs) {
    const spawnVis = beliefs.spawnVisibility ?? new Map();
    const me = beliefs.me ?? { x: 0, y: 0 };
    const tiles = [];
    for (const [key, vis] of spawnVis.entries()) {
        const [x, y] = key.split('_').map(Number);
        const score = vis * 10 - (Math.abs(x - me.x) + Math.abs(y - me.y));
        tiles.push({ x, y, key, score });
    }
    tiles.sort((a, b) => b.score - a.score);
    return tiles;
}

// Finestra d'attesa su una spawn tile prima di ruotare: 2× l'intervallo di
// generazione pacchi (come patrolTimeout() del BDI), altrimenti il fallback.
// parseIntervalMs ritorna Infinity per 'infinite'/non leggibile → fallback.
function acquireWaitMs(beliefs) {
    const p  = beliefs.config?.GAME?.parcels;
    const ms = parseIntervalMs(p?.generation_event ?? p?.generation_time);
    return Number.isFinite(ms) ? ms * ACQUIRE_WAIT_FACTOR : ACQUIRE_WAIT_FALLBACK;
}

// Navigazione interrompibile (shouldStop legato al signal di abort). Ritorna
// true SOLO se è davvero arrivato a (x,y) (riusa l'idea di verifica del tool).
async function navigateInterruptible(ctx, x, y, signal) {
    const { socket, beliefs, deps } = ctx;
    const res = await deps.navigateTo(
        beliefs.me, { x, y }, socket, beliefs.mapTiles, () => signal?.aborted === true
    );
    const here = { x: Math.round(beliefs.me.x), y: Math.round(beliefs.me.y) };
    return res === 'reached' && here.x === x && here.y === y;
}

// Sleep che si risveglia SUBITO se arriva l'abort. Ritorna 'aborted' | 'timeout'.
function abortableSleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted) return resolve('aborted');
        const t = setTimeout(() => { cleanup(); resolve('timeout'); }, ms);
        const onAbort = () => { cleanup(); resolve('aborted'); };
        function cleanup() {
            clearTimeout(t);
            signal?.removeEventListener?.('abort', onAbort);
        }
        signal?.addEventListener?.('abort', onAbort, { once: true });
    });
}

/**
 * ACQUIRE PERSISTENTE (deterministico, NO LLM): assicura di avere un pacco a
 * bordo. Cicla {prendi il visibile più vicino; se non c'è, vai sulla prossima
 * spawn tile e ASPETTA che ne compaia uno, ruotando le tile} finché non porta
 * un pacco. Esce solo su successo o su abort (o sul tetto ACQUIRE_MAX_MS se >0).
 * @returns {Promise<{success:boolean, outcome?:string, error?:string}>}
 */
async function acquireParcelPersistent(ctx, signal) {
    const beliefs   = ctx.beliefs;
    const tag       = '[LLM-ACQUIRE]';
    const carrying  = () => (beliefs.carriedParcels?.length ?? 0) > 0;
    const aborted   = () => signal?.aborted === true;
    const startedAt = Date.now();
    const capped    = () => ACQUIRE_MAX_MS > 0 && (Date.now() - startedAt) >= ACQUIRE_MAX_MS;

    if (carrying()) {
        console.log(`${tag} ho già un pacco a bordo — acquisizione immediata`);
        return { success: true, outcome: 'già carico' };
    }

    let sweep = new Set();   // tile già provate in questa "passata"
    let cycle = 0;
    while (true) {
        if (aborted()) return { success: false, error: 'acquire interrotto (abort)' };
        if (capped())  return { success: false, error: `acquire oltre ACQUIRE_MAX_MS=${ACQUIRE_MAX_MS}ms` };

        // 1) C'è un pacco visibile? Vai a prenderlo.
        const p = nearestVisibleParcel(beliefs);
        if (p) {
            const tx = Math.round(p.x), ty = Math.round(p.y);
            console.log(`${tag} pacco visibile @ (${tx},${ty}) — vado a prenderlo`);
            const arrived = await navigateInterruptible(ctx, tx, ty, signal);
            if (carrying()) { console.log(`${tag} preso in transito ✓`); return { success: true, outcome: `acquisito @ (${tx},${ty})` }; }
            if (aborted())  return { success: false, error: 'acquire interrotto (abort)' };
            if (arrived) {
                const r = await ctx.socket.emitPickup();
                if (r && r.length) { console.log(`${tag} pickup ✓ (${r.length} pacchi)`); return { success: true, outcome: `acquisito @ (${tx},${ty})` }; }
                console.log(`${tag} pacco sparito prima del pickup — continuo`);
            } else {
                console.log(`${tag} pacco non raggiunto — continuo`);
            }
            continue;
        }

        // 2) Nessun pacco visibile → ruota sulla prossima spawn tile e aspetta.
        const tiles = rankedSpawnTiles(beliefs);
        if (tiles.length === 0) {
            console.log(`${tag} nessuna spawn tile nota — attendo e riprovo`);
            if (await abortableSleep(acquireWaitMs(beliefs), signal) === 'aborted')
                return { success: false, error: 'acquire interrotto (abort)' };
            continue;
        }
        let next = tiles.find(t => !sweep.has(t.key));
        if (!next) { sweep = new Set(); next = tiles[0]; cycle++; }   // passata finita → si rivisita
        sweep.add(next.key);

        console.log(`${tag} ciclo ${cycle}: vado su spawn tile (${next.x},${next.y}) [score=${next.score}]`);
        const arrived = await navigateInterruptible(ctx, next.x, next.y, signal);
        if (carrying()) { console.log(`${tag} preso in transito ✓`); return { success: true, outcome: 'acquisito in transito' }; }
        if (aborted())  return { success: false, error: 'acquire interrotto (abort)' };
        if (!arrived) {
            // tile irraggiungibile ora: piccolo backoff per non ciclare a vuoto.
            console.log(`${tag} spawn tile (${next.x},${next.y}) irraggiungibile — provo la prossima`);
            if (await abortableSleep(ACQUIRE_POLL_MS, signal) === 'aborted')
                return { success: false, error: 'acquire interrotto (abort)' };
            continue;
        }

        // Sono sulla spawn tile: aspetto che compaia un pacco (poll), fino a waitMs.
        const waitMs = acquireWaitMs(beliefs);
        console.log(`${tag} su (${next.x},${next.y}), attendo uno spawn fino a ${waitMs}ms`);
        const deadline = Date.now() + waitMs;
        while (Date.now() < deadline) {
            const slept = await abortableSleep(Math.min(ACQUIRE_POLL_MS, deadline - Date.now()), signal);
            if (slept === 'aborted') return { success: false, error: 'acquire interrotto (abort)' };
            if (carrying())                  { console.log(`${tag} pickup opportunistico in attesa ✓`); return { success: true, outcome: 'acquisito in attesa' }; }
            if (nearestVisibleParcel(beliefs)) { console.log(`${tag} pacco apparso — vado a prenderlo`); break; }
            if (capped()) return { success: false, error: `acquire oltre ACQUIRE_MAX_MS=${ACQUIRE_MAX_MS}ms` };
        }
        // torna in cima: o un pacco è apparso (gestito al punto 1), o ruoto tile.
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// FASE 0: COMPRENSIONE (query rewriting → intento JSON strutturato)
//
// 1 sola chiamata LLM il cui UNICO compito è capire COSA fare e in che ORDINE,
// senza inventare coordinate. Da qui ricaviamo gli step in modo DETERMINISTICO
// (compileIntent), così il planner non può allucinare (es. delivery point
// inventati). Separare "capire" da "fare" è ciò che rende il tutto robusto.
// ─────────────────────────────────────────────────────────────────────────────

function buildUnderstandPrompt() {
    return `
You are the COMPREHENSION stage of a Deliveroo agent. Read a special mission in
natural language (any language) and output ONLY a JSON object describing WHAT to
do and in WHICH ORDER. Do NOT plan tool calls. Do NOT add any prose around the JSON.

Schema:
{
  "family": "question" | "atomic" | "rule" | "reactive" | "ignore",
  "reason": "<very short justification>",

  // family "question": answer something to the mission giver
  "compute": "<math expression or null>",   // e.g. "5*5"; null if not arithmetic
  "answer":  "<text to send, or 'computed' to send the computed value>",

  // family "atomic": a one-shot sequence of physical objectives, IN ORDER
  "objectives": [
     { "verb": "move",           "at": [x,y] },                  // go to a tile
     { "verb": "move",           "candidates": [[x,y],[x,y]] },  // go to the CLOSEST of these
     { "verb": "pickup",         "at": [x,y] | "nearest" },      // pick a parcel
     { "verb": "acquire_parcel" },                               // make sure you carry a parcel
     { "verb": "deliver",        "at": [x,y] | "nearest" }       // drop carried parcels here
  ],

  // family "rule": persistent modifier of normal play (installed via set_rule)
  "rules": [ {"type":"forbidden_tile","x":5,"y":7}, {"type":"stack_size","n":3},
             {"type":"zero_delivery","x":2,"y":2}, {"type":"bonus_delivery","x":3,"y":3},
             {"type":"max_parcel_reward","value":10},   // don't PICK UP parcels worth > value
             {"type":"max_deliver_reward","value":10} ],// DELIVERING a parcel worth > value scores 0 → deliver only parcels <= value
  "validity": { "scope": "match" },   // default = whole game; or {"scope":"until_signal","match":"green light"} / {"scope":"duration_ms","ms":30000}

  // family "reactive": conditional/temporal behaviour driven by signals/messages
  "reactive": { "behavior": "freeze_movement", "until": {"signal":"message","match":"green"}, "penalty": -1000 }
}

CRITICAL RULES:
- Use ONLY coordinates that literally appear in the mission text. NEVER invent
  coordinates. For "the nearest parcel/delivery" use the string "nearest".
- Decide ORDER carefully. "Deliver a package IN (x,y)" means: FIRST get a parcel
  (acquire_parcel), THEN deliver at (x,y). The delivery location is (x,y).
- family "ignore" ONLY when the negative reward is the consequence of DOING the
  action (a self-defeating trap) AND there is no obligation. If the penalty is
  for NOT complying (e.g. "lose 1000pts unless you stop/avoid/wait") it is NOT
  ignore — it is "rule" or "reactive". When in doubt, DO NOT ignore.
- "don't / avoid / never cross / never go to X", "stacks of N", "every time",
  "from now on" → family "rule".
- "stop and wait for a message/signal", "red light / green light" → "reactive".

Examples:
Mission: "Calcola 5*5"
{"family":"question","compute":"5*5","answer":"computed"}

Mission: "What is the capital of Italy?"
{"family":"question","compute":null,"answer":"Rome"}

Mission: "Move to (4,7)"
{"family":"atomic","objectives":[{"verb":"move","at":[4,7]}]}

Mission: "Pick up the parcel at (2,3) and deliver it"
{"family":"atomic","objectives":[{"verb":"pickup","at":[2,3]},{"verb":"deliver","at":"nearest"}]}

Mission: "Deliver a package in 1,1 to get a 1000pts bonus. Coordinates are [{\"x\":1,\"y\":1}]"
{"family":"atomic","reason":"acquire then deliver at (1,1)","objectives":[{"verb":"acquire_parcel"},{"verb":"deliver","at":[1,1]}]}

Mission: "Go to one of (1,2)/(3,4) for a bonus"
{"family":"atomic","objectives":[{"verb":"move","candidates":[[1,2],[3,4]]}]}

Mission: "Don't cross 1,1 to get 100pts"
{"family":"rule","reason":"avoid tile for the whole match","rules":[{"type":"forbidden_tile","x":1,"y":1}],"validity":{"scope":"match"}}

Mission: "Deliver in stacks of exactly 3"
{"family":"rule","rules":[{"type":"stack_size","n":3}],"validity":{"scope":"match"}}

Mission: "If you deliver parcels with a score higher than 10, you get no reward."
{"family":"rule","reason":"delivering a parcel worth > 10 scores 0","rules":[{"type":"max_deliver_reward","value":10}],"validity":{"scope":"match"}}

Mission: "Stop at red light and wait for the green light message. Bonus is -1000pts."
{"family":"reactive","reason":"freeze until green light, penalty for moving","reactive":{"behavior":"freeze_movement","until":{"signal":"message","match":"green"},"penalty":-1000}}

Mission: "Move to (1,1) and you get -10pts"
{"family":"ignore","reason":"penalty for doing it, no obligation"}

Output ONLY the JSON object.
`.trim();
}

// Estrae il primo oggetto JSON {...} bilanciato dal testo del modello.
function parseIntentJson(text) {
    const t = String(text || '');
    const start = t.indexOf('{');
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
        const ch = t[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
        } else if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') { if (--depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; } } }
    }
    return null;
}

/**
 * Chiama l'LLM una volta per CAPIRE la missione → intento JSON strutturato.
 * @returns {Promise<object|null>} intento normalizzato, o null se non interpretabile
 */
async function understandMission(missionText, beliefs, tools) {
    const world = await tools.inspect();
    const out = await callModel([
        { role: 'system', content: buildUnderstandPrompt() },
        { role: 'user',   content: `Mission: ${missionText}\n\nCurrent world state:\n${world}` },
    ], { temperature: 0 });

    console.log(`[LLM-UNDERSTAND] risposta modello:\n${out}`);
    const intent = parseIntentJson(out);
    if (!intent || typeof intent.family !== 'string') return null;
    const fam = intent.family.toLowerCase();
    if (!['question', 'atomic', 'rule', 'reactive', 'ignore'].includes(fam)) return null;
    intent.family = fam;
    return intent;
}

// Coordinata [x,y] o {x,y} → stringa "x,y" (null se non valida).
function coordStr(at) {
    if (Array.isArray(at) && at.length >= 2 && at[0] != null && at[1] != null)
        return `${Math.round(at[0])},${Math.round(at[1])}`;
    if (at && typeof at === 'object' && at.x != null && at.y != null)
        return `${Math.round(at.x)},${Math.round(at.y)}`;
    return null;
}

// Tra più candidati, scegli il più vicino a me. Ritorna [x,y] o null.
function nearestCandidate(cands, me) {
    const m = me ?? { x: 0, y: 0 };
    let best = null, bestD = Infinity;
    for (const c of cands ?? []) {
        const cc = Array.isArray(c) ? { x: c[0], y: c[1] } : c;
        if (cc?.x == null || cc?.y == null) continue;
        const d = Math.abs(cc.x - m.x) + Math.abs(cc.y - m.y);
        if (d < bestD) { best = [cc.x, cc.y]; bestD = d; }
    }
    return best;
}

/**
 * Compila DETERMINISTICAMENTE l'intento in step eseguibili (stesso formato che
 * usa l'execution loop). Niente LLM, niente coordinate inventate: i target
 * vengono solo dall'intento (che a sua volta li prende solo dal testo missione).
 * @returns {{steps: Array<{action, target, description}>}}
 */
function compileIntent(intent, beliefs) {
    const steps = [];
    const push = (action, target = '') =>
        steps.push({ action, target: String(target), description: `${action}: ${target}` });

    if (intent.family === 'question') {
        if (intent.compute && String(intent.compute).trim()) {
            push('calculate', String(intent.compute).trim());
            push('answer', 'result');               // invia il valore calcolato
        } else if (intent.answer != null) {
            push('answer', String(intent.answer));
        }
        return { steps };
    }

    if (intent.family === 'atomic') {
        for (const o of Array.isArray(intent.objectives) ? intent.objectives : []) {
            const verb = String(o?.verb || '').toLowerCase();
            if (verb === 'acquire_parcel') { push('go_pick_up', 'nearest'); continue; }

            let coord = coordStr(o?.at);
            if (!coord && Array.isArray(o?.candidates) && o.candidates.length) {
                const best = nearestCandidate(o.candidates, beliefs.me);
                if (best) coord = `${best[0]},${best[1]}`;
            }
            if (verb === 'move'    && coord) push('navigate_to', coord);
            else if (verb === 'pickup')      push('go_pick_up', coord || 'nearest');
            else if (verb === 'deliver')     push('go_deliver', coord || 'nearest');
        }
        return { steps };
    }

    if (intent.family === 'rule') {
        const rules = Array.isArray(intent.rules) ? intent.rules
                    : (intent.rule ? [intent.rule] : []);
        for (const r of rules) if (r && typeof r === 'object') push('set_rule', JSON.stringify(r));
        const scope = intent.validity?.scope;
        if (scope && scope !== 'match') {
            console.warn(`[LLM-UNDERSTAND] validità '${scope}' non auto-applicata nel nucleo: la regola resta persistente (no auto-scadenza).`);
        }
        return { steps };
    }

    // ignore / reactive → nessuno step (gestiti a monte in runMission)
    return { steps };
}


// ── FASE 1: PLANNING ─────────────────────────────────────────────────────────

/**
 * Chiama l'LLM una sola volta per generare il piano.
 * @param {string} missionText
 * @param {object} beliefs
 * @param {object} tools
 * @returns {Promise<{steps: Array<{action, target, description}>, reasoning: string}>}
 */
async function generatePlan(missionText, beliefs, tools) {
    const world = await tools.inspect();   // snapshotWorld(beliefs, activeRules)
    const out = await callModel([
        { role: 'system', content: buildPlannerPrompt() },
        { role: 'user',   content: `Mission: ${missionText}\n\nCurrent world state:\n${world}` },
    ], { temperature: 0 });

    console.log(`[LLM-PLAN] risposta modello:\n${out}`);
    const steps = parsePlan(out);
    return { steps, reasoning: extractFinalAnswer(out) ?? '' };
}


// ── FASE 2: EXECUTION DI UN SINGOLO STEP (nessuna chiamata LLM) ───────────────

/**
 * Esegue un singolo step del piano traducendolo in una (o più) tool call.
 * Non chiama l'LLM.
 * @param {object} step - {action, target}
 * @param {object} ctx
 * @returns {Promise<{success: boolean, outcome?: string, error?: string}>}
 */
async function executeStep(step, ctx, signal = null) {
    const tools   = makeTools(ctx);
    const beliefs = ctx.beliefs;
    const action  = normalizeAction(step.action);
    const target  = step.target ?? '';

    const ok   = (outcome) => ({ success: true,  outcome: String(outcome) });
    const fail = (error)   => ({ success: false, error:   String(error) });
    const isErr = (s) => String(s).startsWith('Error');

    try {
        switch (action) {
            case 'inspect':
                return ok(await tools.inspect());

            case 'calculate': {
                const out = await tools.calculate(target);
                if (isErr(out)) return fail(out);
                const m = String(out).match(/Result:\s*(.+)/);
                if (m) ctx._lastCalcResult = m[1].trim();   // per l'eventuale answer
                return ok(out);
            }

            case 'answer': {
                const text = (ctx._lastCalcResult != null && isResultPlaceholder(target))
                    ? ctx._lastCalcResult
                    : target;
                const out = await tools.answer(text);
                return isErr(out) ? fail(out) : ok(out);
            }

            case 'set_rule': {
                const out = await tools.set_rule(target);
                return isErr(out) ? fail(out) : ok(out);
            }

            case 'navigate_to':
            case 'navigate':
            case 'move':
            case 'go':
            case 'go_to': {
                const c = parseCoords(target);
                if (!c) return fail(`target senza coordinate valide: "${target}"`);
                const out = await tools.navigate_to(`${c.x},${c.y}`);
                return isErr(out) ? fail(out) : ok(out);
            }

            case 'pickup':
                return ok(await tools.pickup());

            case 'putdown':
            case 'drop':
                return ok(await tools.putdown());

            case 'go_pick_up':
            case 'acquire_parcel':
            case 'pick_up':
            case 'pick': {
                const c = parseCoords(target);        // coordinate esplicite dal testo?
                if (!c) {
                    // Target simbolico ("nearest"/vuoto/acquire): ricerca PERSISTENTE
                    // (ruota spawn tile + aspetta gli spawn) finché non porta un pacco
                    // o finché la missione viene interrotta. Niente più resa al primo
                    // controllo a vuoto.
                    return await acquireParcelPersistent(ctx, signal);
                }
                // Coordinate esplicite: pacco SPECIFICO → prova-e-fallisci.
                const nav = await tools.navigate_to(`${c.x},${c.y}`);
                if (isErr(nav)) return fail(nav);
                const pick = await tools.pickup();
                if (/Nessun pacco/i.test(pick)) return fail(`${nav}; ma ${pick}`);
                return ok(`${nav}; ${pick}`);
            }

            case 'go_deliver':
            case 'deliver': {
                let c = parseCoords(target);
                if (!c) {
                    const d = nearestDelivery(beliefs);
                    if (!d) return fail('nessuna delivery tile nota');
                    c = { x: d.x, y: d.y };
                }
                const carriedBefore = beliefs.carriedParcels?.length ?? 0;
                const nav = await tools.navigate_to(`${c.x},${c.y}`);
                if (isErr(nav)) return fail(nav);
                // Durante il tragitto (e soprattutto arrivando sulla delivery tile)
                // `opportunisticActions` consegna automaticamente i pacchi. Quindi
                // se portavo qualcosa e ora non porto più, LA CONSEGNA È AVVENUTA:
                // è un SUCCESSO, non "Niente da consegnare". (Era questo il bug del
                // "lo fa ma pensa di non averlo fatto".)
                const carriedNow = beliefs.carriedParcels?.length ?? 0;
                if (carriedBefore > 0 && carriedNow === 0) {
                    console.log(`[LLM-EXEC] consegna già avvenuta arrivando a (${c.x},${c.y}): ${carriedBefore} pacchi`);
                    return ok(`${nav}; consegnati ${carriedBefore} pacchi (arrivando a destinazione)`);
                }
                const drop = await tools.putdown();
                if (/Niente da consegnare/i.test(drop)) {
                    // Non portavo nulla all'inizio e niente da consegnare → vero fallimento.
                    return fail(`${nav}; ma ${drop}`);
                }
                return ok(`${nav}; ${drop}`);
            }

            default: {
                // Fallback: il modello potrebbe aver usato direttamente il nome
                // di un tool (es. "calculate", "nearest_delivery", "list_rules").
                if (typeof tools[action] === 'function') {
                    const out = await tools[action](target);
                    return isErr(out) ? fail(out) : ok(out);
                }
                return fail(`azione sconosciuta: "${step.action}"`);
            }
        }
    } catch (e) {
        return fail(e.message);
    }
}


// ── FASE 3: REFLECTION (opzionale, solo su errore) ───────────────────────────

/**
 * Chiama l'LLM per correggere il piano quando uno step fallisce. Restituisce il
 * piano RIVISTO per i passi rimanenti (dal passo fallito in poi), senza
 * rigenerare quelli già completati.
 * @param {string} missionText
 * @param {{steps: Array}} originalPlan
 * @param {number} failedStepIndex   indice 0-based del passo fallito
 * @param {string} error
 * @param {object} beliefs
 * @param {object} tools
 * @returns {Promise<{steps: Array, reasoning: string}>}
 */
async function reflectOnError(missionText, originalPlan, failedStepIndex, error, beliefs, tools) {
    const world = await tools.inspect();
    const originalPlanText = originalPlan.steps
        .map((s, idx) => `${idx + 1}. ${s.action}: ${s.target}`)
        .join('\n');

    const user = [
        `Mission: ${missionText}`,
        '',
        'Original plan:',
        originalPlanText,
        '',
        `Error at step ${failedStepIndex + 1}: ${error}`,
        '',
        'Current world state:',
        world,
        '',
        `Generate a REVISED plan from step ${failedStepIndex + 1} onwards. Do not regenerate the steps that already succeeded (1..${failedStepIndex}).`,
    ].join('\n');

    const out = await callModel([
        { role: 'system', content: buildReplannerPrompt() },
        { role: 'user',   content: user },
    ], { temperature: 0 });

    console.log(`[LLM-REFLECTION] risposta modello:\n${out}`);
    const steps = parsePlan(out, failedStepIndex);
    return { steps, reasoning: extractFinalAnswer(out) ?? '' };
}


// ── User message STATEFUL (si aggiorna in-place, non accumula history) ────────

/**
 * Costruisce il messaggio user statico che traccia il progresso. Si aggiorna
 * in-place ad ogni step (non si aggiungono nuovi elementi all'array messages),
 * così il context resta costante.
 * @param {string} missionText
 * @param {{lastAction, lastOutcome, completedSteps, totalSteps}} state
 * @param {object} beliefs
 * @returns {string}
 */
function buildStatefulUserMessage(missionText, state, beliefs) {
    return [
        `Mission: ${missionText}`,
        '',
        '[Current World State]',
        snapshotWorld(beliefs),
        '',
        '[Last Action & Outcome]',
        `Action: ${state.lastAction ?? '(None yet)'}`,
        `Outcome: ${state.lastOutcome ?? ''}`,
        '',
        '[Progress]',
        `Steps: ${state.completedSteps} / ${state.totalSteps ?? '?'}`,
    ].join('\n');
}


// ─────────────────────────────────────────────────────────────────────────────
// RUN MISSION — orchestrazione Planning → Execution → (Reflection) → Completion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Esegue una missione col pattern Planning Decoupled + State-Based Context.
 * @param {string} missionText
 * @param {object} ctx        contesto con { socket, beliefs, deps, lastSender }
 * @param {AbortSignal} [signal]   se .aborted=true la missione viene interrotta
 *                                 tra uno step e l'altro
 */
async function runMission(missionText, ctx, signal = null) {
    const tools  = makeTools(ctx);
    const prompt = buildPrompt(Object.keys(tools));

    // Risultato dell'ultimo calculate, condiviso tra gli step (per "answer: result").
    ctx._lastCalcResult = null;

    // STATE TRACKER — NON viene aggiunto ai messages, traccia solo il progresso.
    const state = {
        lastAction:     null,
        lastOutcome:    null,
        completedSteps: 0,
        totalSteps:     null,
    };

    if (signal?.aborted) {
        console.log('[LLM] Interruzione prima del planning');
        return null;
    }

    // FASE 0: COMPRENSIONE (query rewriting → intento JSON strutturato).
    // Capisce COSA fare e in che ORDINE; la decisione "saltare o no" sta SOLO
    // qui (option b), non nella coda.
    let intent = null;
    try {
        intent = await understandMission(missionText, ctx.beliefs, tools);
    } catch (e) {
        console.warn('[LLM-UNDERSTAND] errore:', e.message);
    }

    if (intent) {
        console.log(`[LLM-UNDERSTAND] family=${intent.family}${intent.reason ? ` — ${intent.reason}` : ''}`);
        if (intent.family === 'ignore') {
            // Unico caso di scarto: trappola auto-lesiva (penalità per AVERLA fatta).
            console.log('[LLM] Missione IGNORATA (trappola auto-lesiva).');
            return `Ignorata: ${intent.reason || 'trappola auto-lesiva'}`;
        }
        if (intent.family === 'reactive') {
            // Riconosciuta ma non eseguita: il freeze è fuori dallo scope del nucleo.
            console.log('[LLM] Missione REATTIVA riconosciuta ma non eseguita (freeze non implementato nel nucleo).');
            return `Riconosciuta (reactive, non eseguita): ${intent.reason || ''}`;
        }
        // SAFETY NET deterministico: un'azione ATOMICA con reward NEGATIVO è una
        // trappola auto-lesiva (penalità per AVERLA fatta) → non eseguirla, anche
        // se l'LLM l'ha classificata "atomic". Le penalità-OBBLIGO sono regole
        // (family 'rule') o reattive, gestite sopra: questo colpisce solo le
        // azioni una-tantum che fanno solo perdere punti.
        if (intent.family === 'atomic') {
            const r = extractReward(missionText);
            if (r != null && r < 0) {
                console.log(`[LLM] Missione IGNORATA (trappola: azione atomica con reward ${r}).`);
                return `Ignorata: trappola auto-lesiva (reward ${r})`;
            }
        }
        // SAFETY NET: una REGOLA con moltiplicatore < 1 è DANNOSA (seguirla
        // ridurrebbe il reward, es. "stacks of 3 to get 0.3 times the reward").
        // Non la installiamo. I moltiplicatori ≥ 1 (double/triple/2x) restano.
        if (intent.family === 'rule') {
            const mult = extractMultiplier(missionText);
            if (mult != null && mult < 1) {
                console.log(`[LLM] Regola IGNORATA (moltiplicatore ${mult} < 1: seguirla ridurrebbe il reward).`);
                return `Ignorata: regola dannosa (moltiplicatore ${mult}x < 1)`;
            }
        }
    }

    // FASE 1: PIANO — deterministico dall'intento; fallback al planner LLM
    // (generatePlan) se la comprensione non è utilizzabile.
    let plan;
    const compiled = intent ? compileIntent(intent, ctx.beliefs) : { steps: [] };
    if (compiled.steps.length > 0) {
        plan = { steps: compiled.steps, reasoning: intent.reason || '' };
        console.log(`[LLM] Intento compilato in ${plan.steps.length} steps (family=${intent.family})`);
    } else {
        console.log('[LLM] Comprensione non utilizzabile → fallback al planner LLM');
        try {
            plan = await generatePlan(missionText, ctx.beliefs, tools);
        } catch (e) {
            console.error('[LLM-PLAN] Errore:', e.message);
            return null;
        }
        console.log(`[LLM] Piano generato: ${plan.steps.length} steps`);
    }
    state.totalSteps = plan.steps.length;
    if (plan.steps.length === 0) {
        console.warn('[LLM] Nessuno step eseguibile');
        return null;
    }

    // MESSAGES ARRAY — SEMPRE 2 elementi [system, user], state-based.
    const messages = [
        { role: 'system', content: prompt },
        { role: 'user',   content: buildStatefulUserMessage(missionText, state, ctx.beliefs) },
    ];

    // FASE 2: EXECUTION LOOP (nessuna chiamata LLM, solo tool call).
    // Indice esplicito invece di for...of: così la reflection può rimpiazzare
    // gli step rimanenti e si può ri-tentare dallo stesso indice.
    let reflections = 0;
    let i = 0;
    while (i < plan.steps.length) {
        if (signal?.aborted) {
            console.log('[LLM] Interruzione durante execution');
            return null;
        }

        const step = plan.steps[i];
        console.log(`[LLM-EXEC] Step ${i + 1}/${plan.steps.length}: ${step.action} → ${step.target}`);

        let outcome;
        try {
            outcome = await executeStep(step, ctx, signal);
        } catch (e) {
            outcome = { success: false, error: e.message };
        }

        if (!outcome.success) {
            // Se è stato l'abort della coda (es. durante un acquire persistente),
            // esci pulito SENZA sprecare una reflection.
            if (signal?.aborted) {
                console.log('[LLM] Interruzione durante execution (acquire/step)');
                return null;
            }
            console.log(`[LLM-EXEC] ✗ Errore: ${outcome.error}`);

            if (reflections >= MAX_REFLECTIONS) {
                console.error(`[LLM-REFLECTION] budget esaurito (${MAX_REFLECTIONS}) — missione fallita`);
                return null;
            }
            reflections++;

            // FASE 3: REFLECTION — correggi il piano dal passo fallito in poi.
            let revised;
            try {
                revised = await reflectOnError(
                    missionText, plan, i, outcome.error, ctx.beliefs, tools
                );
            } catch (e) {
                console.error('[LLM-REFLECTION] Errore:', e.message);
                return null;
            }
            if (revised.steps.length === 0) {
                console.error('[LLM-REFLECTION] piano rivisto vuoto — missione fallita');
                return null;
            }

            // Sostituisci gli step da i in poi col piano rivisto, tieni i completati.
            plan = { ...plan, steps: [...plan.steps.slice(0, i), ...revised.steps] };
            state.totalSteps = plan.steps.length;
            console.log(`[LLM-REFLECTION] Piano corretto: ${plan.steps.length} steps totali`);
            continue;   // ri-tenta dallo stesso indice col nuovo step
        }

        // Success: aggiorna lo state e il messaggio user in-place (no history).
        state.lastAction     = `${step.action}(${step.target})`;
        state.lastOutcome    = outcome.outcome;
        state.completedSteps = i + 1;
        messages[1].content  = buildStatefulUserMessage(missionText, state, ctx.beliefs);

        console.log(`[LLM-EXEC] ✓ Completato: ${outcome.outcome}`);
        i++;
    }

    console.log(`[LLM] ✓ Missione completata: ${state.completedSteps} steps eseguiti`);
    return `Missione completata: ${state.completedSteps}/${state.totalSteps} steps`;
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
    // Riceve text, senderId e un AbortSignal.
    async function executeMission(text, senderId, signal) {
        ctx.lastSender = senderId;
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

        // Accetta missioni SOLO dall'admin
        if (name.toLowerCase() !== 'admin' && name.toLowerCase() !== 'lara') {
            console.log(`[LLM] ignoro messaggio da ${name} (${id}): non è admin`);
            return;
        }

        console.log(`[LLM] Mission da ${name} (${id}): "${text}"`);
        enqueue(text, id);
    });

    console.log('[LLM] Avviato — coda missioni attiva, in ascolto chat');
}


// ─────────────────────────────────────────────────────────────────────────────
// Export interni — utili per test e debug. Non cambiano il comportamento del
// modulo (startLlmAgent resta l'entry point usato da llm_main.js).
// ─────────────────────────────────────────────────────────────────────────────
export {
    runMission, generatePlan, executeStep, reflectOnError,
    buildStatefulUserMessage, parsePlan, extractFinalAnswer,
    normalizeAction, parseCoords, snapshotWorld, makeTools,
    understandMission, parseIntentJson, compileIntent,
    coordStr, nearestCandidate, nearestVisibleParcel, bestSpawnTile,
    acquireParcelPersistent, rankedSpawnTiles, acquireWaitMs,
    navigateInterruptible, abortableSleep,
};
