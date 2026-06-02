// llm_agent.js
// Agente LLM (parte 2 del progetto) — interpreta special missions in linguaggio
// naturale e le esegue chiamando i tool del tuo sistema.
//
// Architettura (slide 12 del prof): Memory → Planner → Exec(Tools) → Replan?
// Pattern di esecuzione: ReAct (Thought / Action / Action Input / Observation),
// preso dal lab8.
//
// STRUTTURA ESTENSIBILE:
//   Livello 1 (implementato): move, calculate, answer, pickup, putdown
//   Livello 2 (predisposto):  registra nuovi tool in TOOLS (es. deliver_stack)
//   Livello 3 (predisposto):  usa communication.js per coordinare col BDI
//
// USO:
//   import { startLlmAgent } from './llm_agent.js';
//   startLlmAgent(socket, beliefs, { navigateTo, getPddlPlan });

import 'dotenv/config';
import OpenAI from 'openai';
import { evaluateMission } from './mission_evaluator.js';
import { initComms, broadcast, getTeammates, sendTo } from './communication.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. CONFIG LLM — LiteLLM UniTN (come lab8)
// ─────────────────────────────────────────────────────────────────────────────

const baseURL = process.env.LITELLM_BASE_URL || 'https://llm.bears.disi.unitn.it/v1';
const apiKey  = process.env.LITELLM_API_KEY;
const MODEL   = process.env.LOCAL_MODEL || 'llama-3.3-70b-lmstudio';

if (!apiKey) {
    // console.error('[LLM] Manca LITELLM_API_KEY nel .env');
    process.exit(1);
}

const client = new OpenAI({ baseURL, apiKey });

async function callModel(messages, { temperature = 0 } = {}) {
    const res = await client.chat.completions.create({ model: MODEL, messages, temperature });
    return res.choices?.[0]?.message?.content ?? '';
}


// ─────────────────────────────────────────────────────────────────────────────
// 2. TOOLS REGISTRY
//    Ogni tool è una funzione async (args, ctx) → string (observation).
//    ctx contiene { socket, beliefs, deps } passati a startLlmAgent.
//    ── Per estendere a L2/L3: aggiungi qui nuovi tool e descrivili nel prompt.
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

        // ── L1: posizione corrente ──────────────────────────────────────────
        get_my_position: () =>
            `x=${Math.round(beliefs.me.x)} y=${Math.round(beliefs.me.y)} score=${beliefs.me.score ?? '?'}`,

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

        // ── L1: rispondi alla game chat / al mittente del prompt ────────────
        answer: (input) => {
            // La missione dice "send the answer to the agent who sent the prompt"
            broadcast('mission_answer', { answer: String(input) });
            // console.log(`[LLM] Risposta inviata: ${input}`);
            return `Risposta inviata: ${input}`;
        },

        // ── L3 (predisposto): chiedi al BDI di fare qualcosa ────────────────
        tell_bdi: (input) => {
            const mates = getTeammates();
            for (const id of mates) sendTo(id, 'llm_request', { text: String(input) });
            return `Richiesta inviata al BDI: ${input}`;
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
- get_my_position(): returns your current x, y, score
- navigate_to(x,y): moves the agent to coordinate x,y
- pickup(): picks up parcels on the current tile
- putdown(): drops carried parcels on the current tile
- answer(text): sends a textual answer back (for questions like "capital of Italy?")
- tell_bdi(text): asks the BDI teammate to do something (coordination missions)

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
- For factual questions, use answer with the correct response.
- After all required tool results are observed, give Final Answer.
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

async function runMission(missionText, ctx) {
    const tools  = makeTools(ctx);
    const prompt = buildPrompt(Object.keys(tools));

    const messages = [
        { role: 'system', content: prompt },
        { role: 'user',   content: `Mission: ${missionText}` },
    ];

    for (let step = 0; step < MAX_STEPS; step++) {
        const out = await callModel(messages, { temperature: 0 });
        messages.push({ role: 'assistant', content: out });

        const final = extractFinal(out);
        if (final) {
            // console.log(`[LLM] ✅ Missione completata: ${final}`);
            return final;
        }

        const act = extractAction(out);
        if (!act) {
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

        // console.log(`[LLM] ${act.action}(${act.input}) → ${observation}`);
        messages.push({ role: 'user', content: `Observation: ${observation}` });
    }

    // console.warn('[LLM] Limite iterazioni raggiunto senza Final Answer');
    return null;
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
    initComms(socket, beliefs);
    const ctx = { socket, beliefs, deps };

    // Le special missions arrivano dal server. A seconda dell'SDK possono arrivare
    // come messaggio dedicato; qui ascoltiamo onMsg con un type 'mission'.
    socket.onMsg(async (id, name, msg) => {
        // Missione in linguaggio naturale (stringa) o oggetto {mission:'...'}
        const text = typeof msg === 'string' ? msg : msg?.mission;
        if (!text) return;

        // console.log(`[LLM] 📩 Special mission ricevuta: "${text}"`);

        // 1. VALUTA se conviene
        const verdict = evaluateMission(text, beliefs);
        // console.log(`[LLM] Valutazione: ${verdict.reason} → ${verdict.worth ? 'ESEGUO' : 'IGNORO'}`);
        if (!verdict.worth) return;

        // 2. ESEGUI con il loop ReAct
        await runMission(text, ctx);
    });

    // console.log('[LLM] Agente LLM avviato — in ascolto di special missions');
}
