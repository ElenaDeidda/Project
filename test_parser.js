// test_parser.js
// Prova il mission_parser su tutte le missioni d'esempio del documento di
// strategia + i casi-bug visti in challenge ("guadagna -100", "pts", ...).
// Non serve il server di gioco: beliefs finti, mappa 10x10.
//
// USO:  node test_parser.js
//   (usa la LITELLM_API_KEY dal .env; se l'LLM non risponde vedrai il
//    fallback regex in azione, comunque sicuro sulle trappole)

import dotenv from 'dotenv';
import fs from 'fs';
const envFile = fs.existsSync('.env.llm') ? '.env.llm' : '.env';
dotenv.config({ path: envFile, override: true });

const { parseMission } = await import('./mission_parser.js');

// Beliefs finti: io in (0,0), mappa 10x10 tutta percorribile
const beliefs = {
    me: { x: 0, y: 0 },
    mapTiles: new Map(),
    deliveryPoints: [{ x: 9, y: 9 }],
};
for (let x = 0; x < 10; x++)
    for (let y = 0; y < 10; y++)
        beliefs.mapTiles.set(`${x}_${y}`, { x, y, type: 1 });

const MISSIONS = [
    // ── L1 dal documento ──
    'Move to coordinate (4,7) and you get +10pts',
    'Move to x=4*2 y=(1+3)*3 to get -10pts',
    'Drop a package in the leftmost tile to get 5pt',
    'Drop a package in the leftmost tile to get -10pt',
    'What is the capital of Italy?',
    'Calculate 5*5',
    // ── casi-bug visti in challenge ──
    'Muoviti in (3,3) e guadagna -100 punti',
    'Move to (2,2) and you gain - 100 pts',
    'Go to one of (1,2), (8,1) or (5,6) for a one-time bonus of 20pts',
    // ── L2 dal documento ──
    'Deliver stacks of exactly 3 parcels at a time to double the reward',
    'Deliver stacks of exactly 5 parcels at a time to get 0.3 of the standard reward',
    'Every time you deliver in (2,2) you get 0pts',
    'Every time you deliver in (3,3) or (7,7) you get 5x pts than in a regular delivery tile',
    'If you deliver parcels with a score higher than 10, you get no reward.',
    'Do not go through tile (5,7) otherwise you lose 50pts.',
    // ── L3 dal documento ──
    'Move both agents to the neighborhood of position (6,6) within a maximum distance of 3, and have them wait for each other. You will receive 500pts.',
    'If a parcel is initially picked up by one agent and later delivered by the other agent, you will receive a 200 points bonus.',
];

for (const text of MISSIONS) {
    const t0 = Date.now();
    const v  = await parseMission(text, beliefs);
    const ms = Date.now() - t0;
    const verdict = v.worth ? '✅ ESEGUI' : '🚫 SCARTA';
    console.log(`\n"${text}"`);
    console.log(`  ${verdict}  L${v.level} ${v.kind}  pri=${v.priority.toFixed(2)}  reward=${v.reward ?? '—'}  mult=${v.multiplier ?? '—'}  noPause=${v.noPause}  [${ms}ms]`);
    if (v.target) console.log(`  target=(${v.target.x},${v.target.y}) cost=${v.cost}`);
    if (v.rule)   console.log(`  rule=${JSON.stringify(v.rule)}`);
    console.log(`  → ${v.reason}`);
}
