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
 * Verdetto principale: la missione conviene?
 * @param {string} missionText
 * @param {object} beliefs   beliefs dell'agente (per posizione/distanze)
 * @returns {{worth:boolean, reward:number|null, cost:number, reason:string}}
 */
export function evaluateMission(missionText, beliefs) {
    const reward = extractReward(missionText);
    const cost   = estimateCost(missionText, beliefs);

    // 1. Reward negativo o zero → TRAPPOLA, ignora sempre
    if (reward !== null && reward <= 0) {
        return { worth: false, reward, cost, reason: 'reward negativo/nullo (trappola)' };
    }

    // 2. Missione "domanda" (calcolo, capitale, ...) → costo zero, sempre conviene
    if (cost === 0 && reward === null) {
        return { worth: true, reward, cost, reason: 'missione informativa, costo nullo' };
    }

    // 3. Reward non dichiarato ma c'è un costo → tentativo cauto (conviene se vicino)
    if (reward === null) {
        const worth = cost <= 10;
        return { worth, reward, cost,
                 reason: worth ? 'reward ignoto ma target vicino' : 'reward ignoto e target lontano' };
    }

    // 4. Calcolo costi/benefici: passi-per-punto sotto la soglia?
    const stepsPerPoint = cost / reward;
    const worth = stepsPerPoint <= STEPS_PER_POINT_THRESHOLD;
    return {
        worth, reward, cost,
        reason: worth
            ? `conviene (${cost} passi per ${reward}pt)`
            : `troppo costosa (${cost} passi per ${reward}pt)`,
    };
}
