// test_executor.js
// Smoke test dell'executor deterministico SENZA server di gioco e SENZA LLM:
// mondo finto 10x10, socket simulato, parser in fallback regex.
// Usa il VERO navigateTo (A*) e i VERI beliefs (singleton), quindi esercita
// il codice reale end-to-end: parse → verdict → executeVerdict.
//
// USO:  node test_executor.js

process.env.PARSER_ATTEMPTS = '1';   // niente retry: senza API key il parser
                                     // va in fallback immediatamente

const { beliefs }        = await import('./beliefs.js');
const { navigateTo }     = await import('./moves.js');
const { parseMission }   = await import('./mission_parser.js');
const { executeVerdict } = await import('./mission_executor.js');

// ── Mondo finto: 10x10 percorribile, delivery a (5,0) e (9,9) ────────────────
for (let x = 0; x < 10; x++)
    for (let y = 0; y < 10; y++)
        beliefs.mapTiles.set(`${x}_${y}`, { type: '1' });
beliefs.mapTiles.set('5_0', { type: '2' });
beliefs.mapTiles.set('9_9', { type: '2' });
beliefs.deliveryPoints.push({ x: 5, y: 0 }, { x: 9, y: 9 });
Object.assign(beliefs.me, { id: 'me', name: 'tester', x: 3, y: 0 });

// ── Socket finto: muove l'agente con 15ms/passo, gestisce pickup/putdown ────
const DIRS = { right: [1, 0], left: [-1, 0], up: [0, 1], down: [0, -1] };
const socket = {
    async emitMove(dir) {
        await new Promise(r => setTimeout(r, 15));
        const [dx, dy] = DIRS[dir];
        return { x: beliefs.me.x + dx, y: beliefs.me.y + dy };
    },
    async emitPickup() {
        const x = Math.round(beliefs.me.x), y = Math.round(beliefs.me.y);
        const picked = [];
        for (const [id, p] of beliefs.parcels) {
            if (!p.carriedBy && Math.round(p.x) === x && Math.round(p.y) === y) {
                picked.push({ ...p, carriedBy: 'me' });
                beliefs.parcels.delete(id);
            }
        }
        if (picked.length) console.log(`   [SOCKET] pickup ${picked.map(p => p.id)} @ (${x},${y})`);
        return picked;
    },
    async emitPutdown(ids) {
        const carried = beliefs.carriedParcels ?? [];
        const drop = ids ? carried.filter(p => ids.includes(p.id)) : [...carried];
        console.log(`   [SOCKET] putdown ${drop.map(p => p.id)} @ (${Math.round(beliefs.me.x)},${Math.round(beliefs.me.y)})`);
        return drop;
    },
    emitSay(to, msg) { console.log(`   [SOCKET] say → ${to}: ${JSON.stringify(msg)}`); },
};

const activeRules = {};
const ctx = { socket, beliefs, deps: { navigateTo, activeRules }, lastSender: 'prof-1' };

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log(`   ✅ ${name}`); }
    else      { fail++; console.log(`   ❌ ${name}`); }
}

async function run(text, { signal = null } = {}) {
    console.log(`\n━━ "${text}"`);
    const verdict = await parseMission(text, beliefs);
    if (!verdict.worth) { console.log(`   (scartata: ${verdict.reason})`); return null; }
    try {
        return await executeVerdict(text, verdict, ctx, signal);
    } catch (e) {
        console.log(`   (rinuncio: ${e.message})`);
        return null;
    }
}

// ── 1. Regola L2: installazione istantanea, zero movimenti ──────────────────
await run('Every time you deliver in (2,2) you get 0pts');
check('zero_delivery installata', activeRules.zeroDeliveries?.some(t => t.x === 2 && t.y === 2));

// ── 2. Domanda-calcolo: risposta senza LLM e senza muoversi ──────────────────
const posBefore = { x: beliefs.me.x, y: beliefs.me.y };
await run('Calculate 5*5');
check('non si è mosso per rispondere', beliefs.me.x === posBefore.x && beliefs.me.y === posBefore.y);

// ── 3. Azione L1 'move' con pacchi in mano: PRIMA consegna, poi task ─────────
beliefs.carriedParcels = [{ id: 'p1', reward: 5 }];
beliefs.carrying = true;
await run('Move to coordinate (4,7) and you get +10pts');
check('arrivato a (4,7)', Math.round(beliefs.me.x) === 4 && Math.round(beliefs.me.y) === 7);
check('pacchi consegnati prima della task', (beliefs.carriedParcels?.length ?? 0) === 0);

// ── 4. Drop nella leftmost: raccoglie un pacco, NON lo consegna per strada ──
beliefs.parcels.set('p2', { id: 'p2', x: 1, y: 0, reward: 3, carriedBy: null });
await run('Drop a package in the leftmost tile to get 5pt');
check('pacco depositato (non più in mano)', (beliefs.carriedParcels?.length ?? 0) === 0);
check('agente sulla colonna leftmost (x=0)', Math.round(beliefs.me.x) === 0);

// ── 5. Abort a metà strada: la missione si ferma SUBITO ─────────────────────
const ac = new AbortController();
setTimeout(() => { console.log('   [TEST] abort!'); ac.abort(); }, 80);
const res = await run('Move to coordinate (9,9) and you get +100pts', { signal: ac.signal });
check('missione interrotta (risultato null)', res === null);
check('NON è arrivato a (9,9)', !(Math.round(beliefs.me.x) === 9 && Math.round(beliefs.me.y) === 9));

// ── 6. "one of [...]": primo candidato in zona chiusa → fallback sul secondo ─
// Riproduce il bug visto in challenge: il candidato più vicino era
// irraggiungibile e la missione moriva con "(20,19) irraggiungibile" in 0.0s.
beliefs.mapTiles.set('7_8', { type: '0' });   // recinto attorno a (8,8):
beliefs.mapTiles.set('8_7', { type: '0' });   // percorribile ma irraggiungibile
beliefs.mapTiles.set('8_9', { type: '0' });
beliefs.mapTiles.set('9_8', { type: '0' });
Object.assign(beliefs.me, { x: 0, y: 7 });
const r6 = await run('Go to one of (8,8) or (9,1) for a one-time bonus of 50pts');
check('fallback candidati: arrivato comunque a (9,1)',
      r6 !== null && Math.round(beliefs.me.x) === 9 && Math.round(beliefs.me.y) === 1);

// ── 7. tutte le coordinate murate/fuori mappa → la missione si scarta ───────
beliefs.mapTiles.set('2_2', { type: '0' });
const v7 = await parseMission('Move to coordinate (2,2) and you get +100pts', beliefs);
check('target murato → scartata al parse', v7.worth === false);
const v8 = await parseMission('Move to coordinate (50,56) and you get +100pts', beliefs);
check('target fuori mappa → scartata al parse', v8.worth === false);

console.log(`\n${fail === 0 ? '🎉' : '⚠️'}  ${pass} ok, ${fail} falliti`);
process.exit(fail === 0 ? 0 : 1);
