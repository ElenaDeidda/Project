// main.js — entry point unico: avvia sia il ramo BDI che il ramo LLM.
//
// bdi/bdi_main.js e llm/llm_main.js sono entrambi script standalone con
// top-level await (si connettono al socket e poi girano in un while(true)
// infinito). Un import statico del primo bloccherebbe per sempre l'avvio
// del secondo, quindi li avviamo con import() dinamico non atteso: partono
// concorrentemente nello stesso processo, ognuno con il proprio .env.

import('./bdi/bdi_main.js');
import('./llm/llm_main.js');
