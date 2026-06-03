// mission_evaluator.js
// Decide se una special mission CONVIENE o va IGNORATA.
// La challenge avverte: alcune missioni sono trappole (reward negativo) o
// costano più di quanto rendono. Questo modulo fa il calcolo costi/benefici.
//
// USO:
//   import { evaluateMission, extractReward } from './mission_evaluator.js';
//   const verdict = evaluateMission(missionText, beliefs);
//   if (verdict.worth) { ...esegui con llm_agent... } else { ...ignora... }

// Stima euristica: passi al secondo dell'agente (per convertire distanza→tempo)
const STEPS_PER_POINT_THRESHOLD = 3; // se servono >3 passi per ogni punto → non conviene

// Pattern che riconoscono una missione di Livello 2 = REGOLA persistente.
// Sono missioni che modificano il comportamento normale del gioco per il
// resto della partita. Vanno installate via set_rule() e tipicamente
// raddoppiano/triplicano i punti per il resto della partita → priorità alta.
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
 * Estrae il reward dichiarato dal testo della missione.
 * Gestisce '+10pts', '-10pt', '5x pts', '200 points', ecc.
 * @returns {number|null}  reward in punti, o null se non trovato
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
 * Stima la distanza/costo per completare la missione.
 * Cerca coordinate target nel testo e calcola la distanza dall'agente.
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
 * Verdetto principale: la missione conviene? E quanto?
 * - `worth`    : false → scartare (trappole, missioni inutilmente costose)
 * - `priority` : numero, più alto = più importante. Usato dalla mission_queue
 *                per scegliere tra missioni concorrenti.
 * @param {string} missionText
 * @param {object} beliefs   beliefs dell'agente (per posizione/distanze)
 * @returns {{worth:boolean, priority:number, reward:number|null, cost:number, reason:string}}
 */
export function evaluateMission(missionText, beliefs) {
    const reward = extractReward(missionText);
    const cost   = estimateCost(missionText, beliefs);
    const isL2   = looksLikeRule(missionText);

    // 0. Livello 2 (regole persistenti): priorità ALTA per default. Vengono
    //    intercettate solo dalle missioni-trappola davvero negative (sotto).
    //    Costo ≈ 0 (l'LLM chiama solo set_rule), valore ≈ doppio per il resto
    //    della partita → priorità 30 di base, smorzata se chiaramente penale
    //    (es. "no reward if ..." che è comunque utile installare per evitare
    //    sprechi di tempo su pacchi che non danno punti).
    if (isL2) {
        // Strict trap: reward esplicitamente negativo → la regola è dannosa,
        // ma installarla è comunque innocuo (es. forbidden_tile). Diamo priorità
        // alta anche in questo caso perché EVITA perdite future.
        const priority = 30;
        return { worth: true, priority, reward, cost,
                 reason: `regola L2 persistente (pri=${priority})` };
    }

    // 1. Trappola atomica (reward esplicito ≤ 0, non-L2) → mai eseguita
    if (reward !== null && reward <= 0) {
        return { worth: false, priority: 0, reward, cost,
                 reason: 'reward negativo/nullo (trappola)' };
    }

    // 2. Missione informativa (no reward, no target) → costo 0
    //    Priorità BASSA: l'agente la esegue solo se non c'è di meglio in coda.
    if (cost === 0 && reward === null) {
        return { worth: true, priority: 0.5, reward, cost,
                 reason: 'missione informativa, costo nullo' };
    }

    // 3. Reward ignoto ma c'è un costo → tentativo cauto
    if (reward === null) {
        const worth = cost <= 10;
        return { worth, priority: worth ? 1.0 : 0, reward, cost,
                 reason: worth ? 'reward ignoto ma target vicino'
                               : 'reward ignoto e target lontano' };
    }

    // 4. Reward noto: priority = reward / (cost+1). Più punti per passo = meglio.
    //    Esempio: 500pt in 5 passi = 83.3; 10pt in 2 passi = 3.3; 10pt in 20 passi = 0.5
    const stepsPerPoint = cost / reward;
    const worth    = stepsPerPoint <= STEPS_PER_POINT_THRESHOLD;
    const priority = worth ? reward / (cost + 1) : 0;
    return {
        worth, priority, reward, cost,
        reason: worth
            ? `${reward}pt in ${cost} passi (pri=${priority.toFixed(2)})`
            : `troppo costosa (${cost} passi per ${reward}pt)`,
    };
}
