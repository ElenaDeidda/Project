// mission_parser.js
// ─────────────────────────────────────────────────────────────────────────────
// STRATEGIA v2: "LLM come compilatore, decisioni nel codice".
//
// Problemi della vecchia pipeline (mission_evaluator euristico + loop ReAct):
//   - LENTA: fino a 8 chiamate LLM per missione, anche per un banale "move to";
//   - FRAGILE: "guadagna -100 punti" veniva eseguita perché la parola
//     "guadagna" suona positiva; "pts" a volte non veniva capito dal modello.
//
// Idea nuova: l'LLM fa UNA SOLA cosa — tradurre il testo della missione in un
// JSON strutturato (che tipo di missione è, reward CON SEGNO, coordinate,
// regola, ...). Tutte le DECISIONI le prende questo modulo, in modo
// deterministico:
//   - il segno del reward è verificato ANCHE da una regex: se il numero è
//     ≤ 0 la missione è scartata, qualunque verbo usi il testo;
//   - "pt/pts/points/punti" sono normalizzati dalla regex, non dal modello;
//   - regole-opportunità con fattore < 1 (es. "stacks of 5 → 0.3x") vengono
//     ignorate: conviene continuare a giocare normale;
//   - regole-vincolo (penalità sul comportamento normale: zero_delivery,
//     forbidden_tile, max_parcel_reward) vengono SEMPRE installate, anche se
//     il numero è negativo: installarle serve proprio a EVITARE la perdita;
//   - le domande ("capital of Italy?", "calculate 5*5") non mettono mai in
//     pausa il BDI: si risponde in chat mentre si continua a giocare.
//
// USO:
//   const verdict = await parseMission(text, beliefs);
//   if (!verdict.worth) → scarta. Altrimenti la mission_queue usa
//   verdict.priority e verdict.noPause; l'executor userà verdict.kind /
//   .action / .rule / .question per eseguire senza altri giri di LLM.
// ─────────────────────────────────────────────────────────────────────────────

import { callModel } from './llm_client.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. ESTRAZIONE DETERMINISTICA DEL REWARD (regex)
//    È la "rete di sicurezza": qualunque cosa dica il modello, se qui troviamo
//    un numero col segno, il segno lo decide la regex.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @returns {{reward:number|null, multiplier:number|null}}
 *   reward     = punti promessi/minacciati, CON SEGNO ("- 100 punti" → -100)
 *   multiplier = fattore moltiplicativo ("double" → 2, "0.3 of the reward" → 0.3)
 */
export function extractRewardRegex(text) {
    const t = String(text).toLowerCase();

    // ── moltiplicatori ──
    let multiplier = null;
    const mx = t.match(/(\d+(?:\.\d+)?)\s*x\s*(?:pts?|points?|punti|the|more)?/);
    if (mx) multiplier = Number(mx[1]);                       // "5x pts", "2x"
    else if (/\b(double|raddoppi\w*)\b/.test(t)) multiplier = 2;
    else if (/\b(triple|triplic\w*)\b/.test(t))  multiplier = 3;
    else if (/\b(halve|half of|met[àa] de)\b/.test(t)) multiplier = 0.5;
    // "0.3 of the (standard) reward" — anche senza spazio: "0.3of"
    const frac = t.match(/(\d*\.\d+|\d+\/\d+)\s*of\s+the\s+(?:standard\s+)?reward/);
    if (frac) {
        if (frac[1].includes('/')) {
            const [a, b] = frac[1].split('/').map(Number);
            if (b) multiplier = a / b;
        } else {
            multiplier = Number(frac[1]);
        }
    }

    // ── reward con unità esplicita: "+10pts", "- 100 punti", "200 points" ──
    // Lo spazio tra segno e cifre è ammesso (era uno dei bug del vecchio parser).
    let reward = null;
    const signed = t.match(/([+-]?\s*\d+(?:\.\d+)?)\s*(?:pts?|points?|punti|punto)\b/);
    if (signed) reward = Number(signed[1].replace(/\s+/g, ''));

    // ── verbi di perdita forzano il segno: "lose 50pts", "perdi 50" ──
    if (reward !== null && /\b(lose|losing|lost|perdi|perder\w*)\b/.test(t)) {
        reward = -Math.abs(reward);
    }
    if (reward === null) {
        const loss = t.match(/\b(?:lose|perdi|perderai)\s+(\d+(?:\.\d+)?)/);
        if (loss) reward = -Number(loss[1]);
    }

    return { reward, multiplier };
}

// Valuta espressioni aritmetiche tipo "4*2" o "(1+3)*3" (coordinate calcolate)
export function evalSafe(expr) {
    const clean = String(expr).replace(/[^0-9+\-*/()\s.]/g, '');
    if (!clean.trim()) throw new Error('espressione vuota');
    // eslint-disable-next-line no-new-func
    const v = Function(`"use strict"; return (${clean});`)();
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('non numerica');
    return v;
}


// ─────────────────────────────────────────────────────────────────────────────
// 2. CHIAMATA LLM — il "compilatore": testo → JSON strutturato
// ─────────────────────────────────────────────────────────────────────────────

const PARSER_PROMPT = `
You translate "special mission" messages from a Deliveroo game chat into JSON.
You DO NOT decide anything and DO NOT execute anything: you only extract structure.

Output ONLY one JSON object, no markdown fences, no explanations. Fields:
{
 "kind": "question" | "action" | "rule" | "coordination",
 "question": "<for kind=question: the question to answer>" or null,
 "reward": <points promised or threatened, WITH SIGN, e.g. -100; null if not stated>,
 "multiplier": <reward multiplier if stated: 2 for "double", 0.3, 5 for "5x"; null otherwise>,
 "action": {"type":"move"|"pickup"|"drop",
            "x":"<number or arithmetic expression as STRING, e.g. \\"4*2\\">" or null,
            "y":"<same>" or null,
            "place":"leftmost"|"rightmost"|"topmost"|"bottommost" or null,
            "candidates":[[x,y],...] or null} or null,
 "rule": {"type":"stack_size"|"forbidden_tile"|"zero_delivery"|"bonus_delivery"|"max_parcel_reward",
          "n":<int, stack_size only>,
          "tiles":[[x,y],...] (tile-based rules),
          "value":<number, max_parcel_reward only>} or null,
 "rule_nature": "opportunity" | "constraint" or null
}

Definitions:
- "question": asks for information or a calculation ("What is the capital of Italy?",
  "Calculate 5*5"). Nothing moves in the game.
- "action": a ONE-SHOT physical task (move somewhere, pick up, drop something).
  Markers: "una tantum", "once", "one-time", explicit coordinates to reach now.
- "rule": changes the game scoring for the REST of the match. Markers: "every time",
  "always", "from now on", "stacks of", "do not go through", "if you deliver ... you get".
- "coordination": involves BOTH/ALL the agents of the team ("both agents",
  "one agent ... the other agent", "all agents", waiting for each other or for a message).
- "rule_nature": "constraint" if the rule changes the payoff of the NORMAL behaviour
  (penalty tiles, zero-point tiles, forbidden tiles, caps on parcel value) — the agent
  must adapt to avoid losing points. "opportunity" if it grants a bonus only when
  ADOPTING a new behaviour (delivering in stacks, preferring a bonus tile).
- "pt", "pts", "points", "punti" all mean game points.
- COPY THE SIGN of rewards exactly: "you get -100pts" → "reward": -100. "lose 50" → -50.
- Coordinates may be arithmetic expressions: "x=4*2 y=(1+3)*3" → "x":"4*2","y":"(1+3)*3".

Examples:

Mission: "Move to coordinate (4,7) and you get +10pts"
{"kind":"action","question":null,"reward":10,"multiplier":null,"action":{"type":"move","x":"4","y":"7","place":null,"candidates":null},"rule":null,"rule_nature":null}

Mission: "Move to x=4*2 y=(1+3)*3 to get -10pts"
{"kind":"action","question":null,"reward":-10,"multiplier":null,"action":{"type":"move","x":"4*2","y":"(1+3)*3","place":null,"candidates":null},"rule":null,"rule_nature":null}

Mission: "Drop a package in the leftmost tile to get 5pt"
{"kind":"action","question":null,"reward":5,"multiplier":null,"action":{"type":"drop","x":null,"y":null,"place":"leftmost","candidates":null},"rule":null,"rule_nature":null}

Mission: "What is the capital of Italy?"
{"kind":"question","question":"What is the capital of Italy?","reward":null,"multiplier":null,"action":null,"rule":null,"rule_nature":null}

Mission: "Go to one of (1,2), (3,4) or (5,6) for a one-time bonus of 20pts"
{"kind":"action","question":null,"reward":20,"multiplier":null,"action":{"type":"move","x":null,"y":null,"place":null,"candidates":[[1,2],[3,4],[5,6]]},"rule":null,"rule_nature":null}

Mission: "Deliver stacks of exactly 3 parcels at a time to double the reward"
{"kind":"rule","question":null,"reward":null,"multiplier":2,"action":null,"rule":{"type":"stack_size","n":3},"rule_nature":"opportunity"}

Mission: "Every time you deliver in (2,2) you get 0pts"
{"kind":"rule","question":null,"reward":0,"multiplier":null,"action":null,"rule":{"type":"zero_delivery","tiles":[[2,2]]},"rule_nature":"constraint"}

Mission: "Every time you deliver in (3,3) or (7,7) you get 5x pts than in a regular delivery tile"
{"kind":"rule","question":null,"reward":null,"multiplier":5,"action":null,"rule":{"type":"bonus_delivery","tiles":[[3,3],[7,7]]},"rule_nature":"opportunity"}

Mission: "If you deliver parcels with a score higher than 10, you get no reward."
{"kind":"rule","question":null,"reward":null,"multiplier":null,"action":null,"rule":{"type":"max_parcel_reward","value":10},"rule_nature":"constraint"}

Mission: "Do not go through tile (5,7) otherwise you lose 50pts."
{"kind":"rule","question":null,"reward":-50,"multiplier":null,"action":null,"rule":{"type":"forbidden_tile","tiles":[[5,7]]},"rule_nature":"constraint"}

Mission: "Move both agents to the neighborhood of position (6,6) within a maximum distance of 3, and have them wait for each other. You will receive 500pts."
{"kind":"coordination","question":null,"reward":500,"multiplier":null,"action":{"type":"move","x":"6","y":"6","place":null,"candidates":null},"rule":null,"rule_nature":null}
`.trim();

async function llmParse(text) {
    const out = await callModel(
        [
            { role: 'system', content: PARSER_PROMPT },
            { role: 'user',   content: `Mission: "${text}"` },
        ],
        { temperature: 0 },
    );
    // Il modello a volte avvolge il JSON in testo/fence: estraiamo il primo {...}
    const m = String(out).match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`nessun JSON nella risposta: ${String(out).slice(0, 120)}`);
    return JSON.parse(m[0]);
}


// ─────────────────────────────────────────────────────────────────────────────
// 3. FALLBACK SENZA LLM — se la chiamata fallisce (timeout/rete) non perdiamo
//    la missione: classificazione grezza via regex, prudente.
// ─────────────────────────────────────────────────────────────────────────────

const RULE_PATTERNS = [
    /stacks?\s+of/i, /every\s+time/i, /each\s+(time|delivery)/i, /\balways\b/i,
    /from\s+now\s+on/i, /\b(do\s+not|don'?t|avoid)\b.*\b(go|deliver|pick|cross)\b/i,
    /if\s+you\s+(deliver|pick|drop|go)/i, /\bno\s+reward\b/i,
    /reward\s+(higher|lower|greater|less)\s+than/i,
];

function fallbackParse(text) {
    const t = String(text).toLowerCase();
    if (/\?\s*$/.test(t) || /^(what|who|where|which|how|calculate|calcola|quanto)\b/.test(t)) {
        return { kind: 'question', question: text };
    }
    if (/\b(both|all)\s+agents?\b/.test(t) || /\bthe other agent\b/.test(t)) {
        return { kind: 'coordination' };
    }
    if (RULE_PATTERNS.some(re => re.test(t))) {
        // Natura della regola: "stacks of" e i bonus sono chiaramente opt-in
        // (opportunity) → se il fattore è < 1 verranno scartate dalle guardie.
        // Tutto il resto → 'constraint' per prudenza (installare non costa).
        const nature = /stacks?\s+of/.test(t) || /\b\d+(\.\d+)?\s*x\b|bonus/.test(t)
            ? 'opportunity' : 'constraint';
        return { kind: 'rule', rule: null, rule_nature: nature };
    }
    const action = { type: /\b(drop|putdown|consegna)\b/.test(t) ? 'drop'
                        : /\b(pick|raccogli|prendi)\b/.test(t)   ? 'pickup' : 'move' };
    const parens = [...text.matchAll(/\((\d+)\s*,\s*(\d+)\)/g)];
    if (parens.length === 1) { action.x = parens[0][1]; action.y = parens[0][2]; }
    else if (parens.length > 1) {
        // più coordinate ("one of (1,2), (3,4)...") → candidati, si sceglie il
        // più vicino in resolveAction
        action.candidates = parens.map(m => [Number(m[1]), Number(m[2])]);
    }
    else {
        const xm = text.match(/x\s*=\s*([\d*+()\s.\/-]+?)(?=\s*y\s*=|\s*$)/i);
        const ym = text.match(/y\s*=\s*([\d*+()\s.\/-]+?)(?=\s+to\b|\s*$)/i);
        if (xm && ym) { action.x = xm[1].trim(); action.y = ym[1].trim(); }
    }
    if (/\bleftmost\b/.test(t))   action.place = 'leftmost';
    if (/\brightmost\b/.test(t))  action.place = 'rightmost';
    return { kind: 'action', action };
}


// ─────────────────────────────────────────────────────────────────────────────
// 4. RISOLUZIONE COORDINATE + COSTO
// ─────────────────────────────────────────────────────────────────────────────

// Tile estrema della mappa ("leftmost" = x minima fra le tile percorribili;
// a parità, la più vicina a me). Vale per QUALSIASI tile, delivery o no.
function extremeTile(place, beliefs) {
    const tiles = [...(beliefs?.mapTiles?.values() ?? [])];
    if (tiles.length === 0) return null;
    const key  = (place === 'leftmost' || place === 'rightmost') ? 'x' : 'y';
    const best = (place === 'leftmost' || place === 'topmost')
        ? Math.min(...tiles.map(t => t[key]))
        : Math.max(...tiles.map(t => t[key]));
    const cands = tiles.filter(t => t[key] === best);
    const me = beliefs?.me ?? { x: 0, y: 0 };
    cands.sort((a, b) =>
        (Math.abs(a.x - me.x) + Math.abs(a.y - me.y)) -
        (Math.abs(b.x - me.x) + Math.abs(b.y - me.y)));
    return { x: cands[0].x, y: cands[0].y };
}

// Normalizza candidates: accetta [[x,y],...] o [{x,y},...]
function normCandidates(cands) {
    if (!Array.isArray(cands)) return [];
    return cands
        .map(c => Array.isArray(c) ? { x: Number(c[0]), y: Number(c[1]) }
                                   : { x: Number(c?.x), y: Number(c?.y) })
        .filter(c => Number.isFinite(c.x) && Number.isFinite(c.y));
}

/**
 * Risolve il target di un'azione: coordinate (anche come espressioni "4*2"),
 * lista di candidati (→ il più vicino), o posto simbolico ("leftmost").
 * @returns {{target:{x:number,y:number}|null, cost:number}}
 */
function resolveAction(action, beliefs) {
    if (!action) return { target: null, cost: 0 };
    const me = beliefs?.me;
    let target = null;

    if (action.x != null && action.y != null) {
        try {
            target = { x: Math.round(evalSafe(action.x)), y: Math.round(evalSafe(action.y)) };
        } catch { /* espressione non valutabile → prova le altre strade */ }
    }
    if (!target) {
        const cands = normCandidates(action.candidates);
        if (cands.length > 0 && me) {
            cands.sort((a, b) =>
                (Math.abs(a.x - me.x) + Math.abs(a.y - me.y)) -
                (Math.abs(b.x - me.x) + Math.abs(b.y - me.y)));
            target = cands[0];
        }
    }
    if (!target && action.place) target = extremeTile(action.place, beliefs);

    const cost = (target && me)
        ? Math.abs(target.x - me.x) + Math.abs(target.y - me.y)
        : 0;
    return { target, cost };
}


// ─────────────────────────────────────────────────────────────────────────────
// 5. IL VERDETTO — qui stanno TUTTE le decisioni (deterministico)
// ─────────────────────────────────────────────────────────────────────────────

const STEPS_PER_POINT_THRESHOLD = 3;   // > 3 passi per punto → non conviene

/**
 * @param {string} text     testo della missione
 * @param {object} beliefs  beliefs dell'agente (posizione, mappa)
 * @returns {Promise<{
 *   worth:boolean, priority:number, kind:string, level:number,
 *   reward:number|null, multiplier:number|null, cost:number,
 *   target:{x:number,y:number}|null, action:object|null, rule:object|null,
 *   question:string|null, noPause:boolean, reason:string
 * }>}
 */
export async function parseMission(text, beliefs) {
    // 1. LLM-compilatore (1 chiamata). Se fallisce → fallback regex.
    let parsed;
    try {
        parsed = await llmParse(text);
    } catch (e) {
        console.warn(`[PARSER] LLM non disponibile (${e.message}) → fallback regex`);
        parsed = fallbackParse(text);
    }

    // 2. Rete di sicurezza sul reward: la regex decide il segno.
    const rgx = extractRewardRegex(text);
    let reward = parsed.reward ?? null;
    if (rgx.reward !== null) {
        // In disaccordo col modello → vince il valore più pessimista.
        reward = (reward === null) ? rgx.reward : Math.min(reward, rgx.reward);
    }
    const multiplier = rgx.multiplier ?? parsed.multiplier ?? null;

    const kind = ['question', 'action', 'rule', 'coordination'].includes(parsed.kind)
        ? parsed.kind : 'action';

    const base = {
        kind, reward, multiplier,
        action: parsed.action ?? null,
        rule: parsed.rule ?? null,
        question: parsed.question ?? null,
        target: null, cost: 0, noPause: false,
    };

    // ── DOMANDA: si risponde in chat SENZA fermare il BDI ──
    if (kind === 'question') {
        return { ...base, level: 1, worth: true, priority: 2, noPause: true,
                 reason: 'domanda: rispondo senza fermare il BDI' };
    }

    // ── COORDINAMENTO (L3): vale tanti punti, ma trappola se reward ≤ 0 ──
    if (kind === 'coordination') {
        if (reward !== null && reward <= 0) {
            return { ...base, level: 3, worth: false, priority: 0,
                     reason: `coordinamento con reward ${reward} ≤ 0 (trappola)` };
        }
        return { ...base, level: 3, worth: true, priority: 40,
                 reason: `coordinamento L3 (reward=${reward ?? '?'})` };
    }

    // ── REGOLA (L2) ──
    if (kind === 'rule') {
        const nature = parsed.rule_nature === 'opportunity' ? 'opportunity' : 'constraint';
        if (nature === 'opportunity' &&
            ((multiplier !== null && multiplier < 1) || (reward !== null && reward <= 0))) {
            return { ...base, level: 2, worth: false, priority: 0,
                     reason: `regola-opportunità svantaggiosa (x${multiplier ?? '?'}, ${reward ?? '?'}pt): continuo a giocare normale` };
        }
        // I vincoli si installano SEMPRE: servono a evitare perdite future.
        return { ...base, level: 2, worth: true, priority: 30,
                 reason: nature === 'constraint'
                     ? 'regola-vincolo: la installo per evitare perdite'
                     : `regola-opportunità vantaggiosa (x${multiplier ?? '?'})` };
    }

    // ── AZIONE ATOMICA (L1) ──
    if (reward !== null && reward <= 0) {
        return { ...base, level: 1, worth: false, priority: 0,
                 reason: `reward ${reward} ≤ 0 (trappola)` };
    }
    if (multiplier !== null && multiplier < 1) {
        return { ...base, level: 1, worth: false, priority: 0,
                 reason: `fattore x${multiplier} < 1 (non conviene)` };
    }

    const { target, cost } = resolveAction(parsed.action, beliefs);
    if (reward === null) {
        const worth = cost <= 10;
        return { ...base, level: 1, target, cost, worth, priority: worth ? 1.0 : 0,
                 reason: worth ? 'reward ignoto ma target vicino'
                               : 'reward ignoto e target lontano' };
    }
    const worth    = cost / reward <= STEPS_PER_POINT_THRESHOLD;
    const priority = worth ? reward / (cost + 1) : 0;
    return { ...base, level: 1, target, cost, worth, priority,
             reason: worth ? `${reward}pt in ${cost} passi (pri=${priority.toFixed(2)})`
                           : `troppo costosa (${cost} passi per ${reward}pt)` };
}
