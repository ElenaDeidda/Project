// main.js — entry point unico: avvia bdi_main.js e llm_main.js come due
// processi Node separati (non import nello stesso processo): entrambi
// caricano il proprio .env con dotenv.config({ override: true }), quindi
// condividerebbero (e si sovrascriverebbero) process.env se girassero nello
// stesso processo. Con spawn ognuno ha il proprio process.env duplicato.

import { spawn } from 'child_process';

const bdi = spawn('node', ['bdi/bdi_main.js'], { stdio: 'inherit' });
const llm = spawn('node', ['llm/llm_main.js'], { stdio: 'inherit' });

bdi.on('exit', (code) => console.log(`[MAIN] bdi_main.js terminato (code ${code})`));
llm.on('exit', (code) => console.log(`[MAIN] llm_main.js terminato (code ${code})`));
