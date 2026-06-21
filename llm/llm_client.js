// llm_client.js
// Config LLM + transport: client OpenAI/LiteLLM e wrapper callModel con timeout.
// Modulo foglia. Legge process.env e fa process.exit(1) se manca la chiave.

import OpenAI from 'openai';

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG LLM - LiteLLM UniTN (come lab8)
// ─────────────────────────────────────────────────────────────────────────────

const baseURL = process.env.LITELLM_BASE_URL || 'https://llm.bears.disi.unitn.it/v1';
const apiKey  = process.env.LITELLM_API_KEY;
const MODEL   = process.env.LOCAL_MODEL || 'llama-3.3-70b-lmstudio';

// Temperatura del modello (override con LLM_TEMP). 0.2-0.3 aiuta a uscire dai loop.
const TEMP    = Number(process.env.LLM_TEMP ?? 0.2);

if (!apiKey) {
    // console.error('[LLM] Manca LITELLM_API_KEY nel .env');
    process.exit(1);
}

const client = new OpenAI({ baseURL, apiKey });

const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 30000);

// Timeout esplicito: se l'API resta appesa, throw -> il loop ReAct riprova.
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
