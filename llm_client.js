// llm_client.js
// Client LiteLLM condiviso (parser + agente). Un solo punto dove vive la
// configurazione del modello, così parser ed executor non duplicano nulla.
//
// NB: legge process.env al momento dell'import → va importato DOPO che
// llm_main.js ha caricato dotenv (stesso pattern di llm_agent.js).

import OpenAI from 'openai';

const baseURL = process.env.LITELLM_BASE_URL || 'https://llm.bears.disi.unitn.it/v1';
const apiKey  = process.env.LITELLM_API_KEY;

export const MODEL = process.env.LOCAL_MODEL || 'llama-3.3-70b-lmstudio';
export const TEMP  = Number(process.env.LLM_TEMP ?? 0.2);

const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 30000);

const client = apiKey ? new OpenAI({ baseURL, apiKey }) : null;

/**
 * Una chiamata chat al modello, con timeout esplicito: se l'API resta appesa
 * non vogliamo bloccare la coda missioni per minuti.
 * @param {Array<{role:string, content:string}>} messages
 * @returns {Promise<string>} il testo della risposta
 */
export async function callModel(messages, { temperature = TEMP, timeoutMs = LLM_TIMEOUT_MS } = {}) {
    if (!client) throw new Error('LITELLM_API_KEY mancante nel .env');
    return await Promise.race([
        client.chat.completions.create({ model: MODEL, messages, temperature })
            .then(r => r.choices?.[0]?.message?.content ?? ''),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`LLM timeout ${timeoutMs}ms`)), timeoutMs)
        ),
    ]);
}
