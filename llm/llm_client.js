// llm_client.js
// Config LLM + transport: client OpenAI/LiteLLM e wrapper callModel con timeout.
// Modulo foglia: tutti gli altri moduli dell'agente dipendono (in)direttamente
// da qui. L'effetto collaterale di lettura `process.env` + eventuale
// process.exit(1) per chiave mancante vive QUI (era in llm_agent.js).

import OpenAI from 'openai';

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG LLM - LiteLLM UniTN (come lab8)
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
// non vogliamo che il loop ReAct si pianti per minuti. Throw -> il loop
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

export { callModel, MODEL, TEMP };
