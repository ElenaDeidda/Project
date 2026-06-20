// llm_parsers.js
// Parsing puro di testo/JSON dell'LLM: piano, nomi azione, coordinate, intento JSON.

/**
 * Estrae il final answer dal testo dell'LLM. Cerca "FINAL ANSWER: ...".
 * @returns {string | null}
 */
function extractFinalAnswer(text) {
    const m = String(text || '').match(/^\s*FINAL ANSWER:\s*(.+)$/im);
    return m ? m[1].trim() : null;
}

/**
 * Estrae il piano dal testo dell'LLM, tollerante alle variazioni di formato
 * (numerazione, bullet). Isola la sezione "PLAN:" e ignora "FINAL ANSWER: ...".
 * @returns {Array<{action: string, target: string, description: string}>}
 */
function parsePlan(llmText, startIndex = 0) {  // eslint-disable-line no-unused-vars
    const text = String(llmText || '');

    // Isola il corpo del piano: preferisci cio che segue "PLAN:".
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

// Normalizza il nome azione: minuscolo, separatori -> "_", via i caratteri di
// markdown (** `` ecc.). "Go Pick Up" / "**go_pick_up**" -> "go_pick_up".
function normalizeAction(a) {
    return String(a).trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');
}

// Il target di un passo "answer" e un segnaposto che rimanda al risultato di un
// calculate precedente? (cosi non "inventiamo" il numero: lo prendiamo dal tool)
function isResultPlaceholder(t) {
    const s = String(t).trim().toLowerCase();
    return s === '' || /^<.*>$/.test(s) || /\b(result|risultato|computed|above|previous)\b/.test(s);
}

// Estrae "(x,y)" da una stringa target. Null se non ci sono coordinate.
function parseCoords(s) {
    const m = String(s).match(/\(?\s*(-?\d+)\s*,\s*(-?\d+)\s*\)?/);
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
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

export {
    extractFinalAnswer, parsePlan, parseStepContent, normalizeAction,
    isResultPlaceholder, parseCoords, parseIntentJson,
};
