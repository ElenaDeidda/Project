// main.js — entry point: avvia bdi_main.js e llm_main.js come processi Node
// separati, cosi ognuno ha il proprio process.env (.env con override).

import { spawn } from 'child_process';

const bdi = spawn('node', ['bdi/bdi_main.js'], { stdio: 'inherit' });
const llm = spawn('node', ['llm/llm_main.js'], { stdio: 'inherit' });

bdi.on('exit', (code) => console.log(`[MAIN] bdi_main.js terminato (code ${code})`));
llm.on('exit', (code) => console.log(`[MAIN] llm_main.js terminato (code ${code})`));
