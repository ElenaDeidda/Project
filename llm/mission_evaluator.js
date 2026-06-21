// mission_evaluator.js
// Calcolo costi/benefici di una special mission: priorità in coda e riconoscimento
// delle regole L2.

// Pattern di una missione L2 = regola persistente (installata via set_rule).
const L2_PATTERNS = [
    /stacks?\s+of/i,                 // "stacks of 3", "stacks of exactly 5 ..."
    /every\s+time/i,                 // "every time you deliver"
    /each\s+(time|delivery)/i,       // "each delivery"
    /\balways\b/i,                   // "always"
    /from\s+now\s+on/i,              // "from now on"
    /\b(do\s+not|don'?t|avoid)\b.*\b(go|deliver|pick|cross)\b/i,
    /if\s+you\s+(deliver|pick|drop|go)/i,
    /\bno\s+reward\b/i,
    /\b(double|triple|quadruple|halve|5x|2x|3x)\b/i,
    /reward\s+(higher|lower|greater|less)\s+than/i,  // "reward higher than 10"
];

function looksLikeRule(text) {
    return L2_PATTERNS.some(re => re.test(text));
}


/**
 * Estrae il reward dichiarato dal testo ('+10pts', '-10pt', '5x pts', '200 points').
 * @returns {number|null}  reward in punti, null se non trovato
 */
export function extractReward(text) {
    const t = text.toLowerCase();

    // Pattern moltiplicatore: "5x pts" → trattato come bonus alto (50)
    const mult = t.match(/(\d+)\s*x\s*(pts|points|punti)/);
    if (mult) return Number(mult[1]) * 10;

    // Pattern con unità esplicita: +10pts, -10pt, 200 points
    const signed = t.match(/([+-]?\d+)\s*(pts|points|punti|pt)\b/);
    if (signed) return Number(signed[1]);

    // Fallback: numero (con segno) preceduto da verbi tipici di reward.
    // Match "to get +10", "earn 50", "lose 5", "you receive 200".
    // Se il verbo è "loss-like" (lose/perdi/perdere), forza il segno negativo.
    const verb = t.match(
        /(get|gain|earn|score|win|receive|reward|lose|perdi|perd[eo]|guadagn[aiou]+)\s*[a-z\s]{0,15}?([+-]?\d+)\b/
    );
    if (verb) {
        const isLoss = /^(lose|perdi|perd[eo])$/.test(verb[1]);
        const n      = Number(verb[2]);
        return isLoss ? -Math.abs(n) : n;
    }

    return null;
}


/**
 * Estrae un moltiplicatore del reward dal testo ("double"→2, "halve"→0.5,
 * "0.3 times"→0.3). Distingue regola conveniente (≥1) da dannosa (<1). null se assente.
 * @returns {number|null}
 */
export function extractMultiplier(text) {
    const t = String(text).toLowerCase();
    if (/\bhalve\b|\bhalf\b/.test(t))   return 0.5;
    if (/\bquadrupl/.test(t))           return 4;
    if (/\btripl/.test(t))              return 3;
    if (/\bdoubl/.test(t))              return 2;
    // "0.3 times", "2x", "1.5 times the reward"
    let m = t.match(/(\d+(?:\.\d+)?)\s*(?:x\b|times\b)/);
    if (m) return parseFloat(m[1]);
    // "0.3 of the (standard/normal/full) reward", anche senza spazio ("0.3of")
    m = t.match(/(\d+(?:\.\d+)?)\s*of\s+(?:the\s+|its\s+|a\s+)?(?:standard\s+|normal\s+|original\s+|full\s+|usual\s+|base\s+)?reward/);
    if (m) return parseFloat(m[1]);
    // "X% of the reward" → frazione
    m = t.match(/(\d+(?:\.\d+)?)\s*%\s*of\s+(?:the\s+)?(?:standard\s+|normal\s+)?reward/);
    if (m) return parseFloat(m[1]) / 100;
    return null;
}


/**
 * Stima il costo in passi: distanza dall'agente al target trovato nel testo.
 * @returns {number}  passi stimati (0 se nessun movimento richiesto)
 */
function estimateCost(text, beliefs) {
    // Cerca coordinate tipo (4,7) o x=8 y=12
    const paren = text.match(/\((\d+)\s*,\s*(\d+)\)/);
    let target = null;
    if (paren) {
        target = { x: Number(paren[1]), y: Number(paren[2]) };
    } else {
        const xm = text.match(/x\s*=\s*([\d*+()\s]+)/i);
        const ym = text.match(/y\s*=\s*([\d*+()\s]+)/i);
        if (xm && ym) {
            try {
                target = { x: evalSafe(xm[1]), y: evalSafe(ym[1]) };
            } catch { /* ignora */ }
        }
    }

    if (!target || !beliefs?.me) return 0;
    return Math.abs(target.x - beliefs.me.x) + Math.abs(target.y - beliefs.me.y);
}

// Valuta espressioni aritmetiche semplici come "4*2" o "(1+3)*3" senza eval pericoloso
function evalSafe(expr) {
    const clean = expr.replace(/[^0-9+\-*/()\s.]/g, '');
    if (!clean.trim()) throw new Error('vuota');
    // eslint-disable-next-line no-new-func
    return Function(`"use strict"; return (${clean});`)();
}


/**
 * Verdetto: priorità della missione per la mission_queue (più alto = più importante).
 * @returns {{worth:boolean, priority:number, reward:number|null, cost:number, reason:string}}
 */
export function evaluateMission(missionText, beliefs) {
    const reward = extractReward(missionText);
    const cost   = estimateCost(missionText, beliefs);
    const isL2   = looksLikeRule(missionText);

    // 0. Regola L2: urgente e a costo ~0. Priorità per magnitudine |reward|,
    //    base 30 quando il numero non è dichiarato.
    if (isL2) {
        const mag = reward != null ? Math.abs(reward) : null;
        const priority = mag != null ? Math.max(30, mag) : 30;
        return { worth: true, priority, urgent: true, reward, cost,
                 reason: `regola L2 (URGENTE, magnitudine=${mag ?? '—'}, pri=${priority})` };
    }

    // Policy "esegui sempre": la coda non cestina, lo skip lo decide la
    // COMPRENSIONE in llm_agent (family:"ignore"). Qui solo la priorità.

    // 1. Reward ≤ 0 (non-L2): priorità minima, decisione rimandata alla comprensione.
    if (reward !== null && reward <= 0) {
        return { worth: true, priority: 0.1, reward, cost,
                 reason: 'reward ≤ 0: decisione rimandata alla comprensione' };
    }

    // 2. Missione informativa (no reward, no target): priorità bassa.
    if (cost === 0 && reward === null) {
        return { worth: true, priority: 0.5, reward, cost,
                 reason: 'missione informativa, costo nullo' };
    }

    // 3. Reward ignoto con costo: priorità in base alla vicinanza del target.
    if (reward === null) {
        const near = cost <= 10;
        return { worth: true, priority: near ? 1.0 : 0.3, reward, cost,
                 reason: near ? 'reward ignoto, target vicino'
                              : 'reward ignoto, target lontano' };
    }

    // 4. Reward noto: priority = reward / (cost+1) (più punti per passo = priorità più alta).
    const priority = reward / (cost + 1);
    return {
        worth: true, priority, reward, cost,
        reason: `${reward}pt in ${cost} passi (pri=${priority.toFixed(2)})`,
    };
}
