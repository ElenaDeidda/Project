// mission_evaluator.js
// Decide se una special mission CONVIENE o va IGNORATA.
// La challenge avverte: alcune missioni sono trappole (reward negativo) o
// costano più di quanto rendono. Questo modulo fa il calcolo costi/benefici.
//
// USO:
//   import { evaluateMission, extractReward } from './mission_evaluator.js';
//   const verdict = evaluateMission(missionText, beliefs);
//   if (verdict.worth) { ...esegui con llm_agent... } else { ...ignora... }

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
        // Regola persistente = URGENTE (va installata subito) e a COSTO ~0
        // (l'LLM chiama solo set_rule, niente viaggio: ignoriamo `cost`).
        // Priorità per MAGNITUDINE: |reward| (evitare −1000 ≈ guadagnare +1000),
        // con una base alta di default quando il numero non è dichiarato.
        const mag = reward != null ? Math.abs(reward) : null;
        const priority = mag != null ? Math.max(30, mag) : 30;
        return { worth: true, priority, urgent: true, reward, cost,
                 reason: `regola L2 (URGENTE, magnitudine=${mag ?? '—'}, pri=${priority})` };
    }

    // NOTA (policy "esegui sempre"): la coda NON cestina più le missioni. La
    // decisione "saltare o no" è demandata allo stadio di COMPRENSIONE in
    // llm_agent (family:"ignore" = trappola auto-lesiva). Qui calcoliamo SOLO
    // la priorità. Così non buttiamo via missioni-obbligo a penalità (es. il
    // "red light/green light", che ha reward negativo ma è un OBBLIGO).

    // 1. Reward esplicito ≤ 0 (non-L2): NON scartata, ma priorità minima — la
    //    comprensione deciderà se è una trappola da ignorare o un obbligo.
    if (reward !== null && reward <= 0) {
        return { worth: true, priority: 0.1, reward, cost,
                 reason: 'reward ≤ 0: decisione rimandata alla comprensione' };
    }

    // 2. Missione informativa (no reward, no target) → costo 0
    //    Priorità BASSA: l'agente la esegue solo se non c'è di meglio in coda.
    if (cost === 0 && reward === null) {
        return { worth: true, priority: 0.5, reward, cost,
                 reason: 'missione informativa, costo nullo' };
    }

    // 3. Reward ignoto ma c'è un costo → eseguita comunque, priorità in base
    //    alla vicinanza del target (più vicino = priorità un filo più alta).
    if (reward === null) {
        const near = cost <= 10;
        return { worth: true, priority: near ? 1.0 : 0.3, reward, cost,
                 reason: near ? 'reward ignoto, target vicino'
                              : 'reward ignoto, target lontano' };
    }

    // 4. Reward noto: eseguita comunque. priority = reward / (cost+1): più punti
    //    per passo = priorità più alta (le "troppo costose" finiscono in fondo
    //    alla coda, ma NON vengono scartate).
    //    Esempio: 500pt in 5 passi = 83.3; 10pt in 2 passi = 3.3; 10pt in 20 passi = 0.5
    const priority = reward / (cost + 1);
    return {
        worth: true, priority, reward, cost,
        reason: `${reward}pt in ${cost} passi (pri=${priority.toFixed(2)})`,
    };
}
