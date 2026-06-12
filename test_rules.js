// test_rules.js
// Test deterministico del rules_engine (pezzo 3): strategia del timer per
// max_parcel_reward e forbidden_tile come muro. Nessun server, nessun LLM.
//
// USO:  node test_rules.js

import {
    installRule, applyRulesToPredicate, applyRulesToBeliefs,
    travelDecay, shouldDepart,
} from './rules_engine.js';

let pass = 0, fail = 0;
function check(name, cond) {
    if (cond) { pass++; console.log(`✅ ${name}`); }
    else      { fail++; console.log(`❌ ${name}`); }
}

// Mondo finto: 10x10, delivery (9,0), decay 1pt/s, 500ms a passo
function freshBeliefs() {
    const b = {
        me: { x: 0, y: 0 },
        config: { GAME: { player: { movement_duration: 500 },
                          parcels: { decaying_event: '1s' } } },
        mapTiles: new Map(),
        deliveryPoints: [{ x: 9, y: 0 }],
        parcels: new Map(),
        agents: new Map(),
        carriedParcels: [],
        spawnVisibility: new Map([['5_5', 10]]),
    };
    for (let x = 0; x < 10; x++)
        for (let y = 0; y < 10; y++)
            b.mapTiles.set(`${x}_${y}`, { type: '1' });
    b.mapTiles.set('9_0', { type: '2' });
    return b;
}

// ── 1. Matematica del timer ──────────────────────────────────────────────────
// 5 passi × 500ms = 2.5s di viaggio = 2.5 punti di decay
const b1 = freshBeliefs();
check('travelDecay: 5 passi → 2.5pt', travelDecay(5, b1) === 2.5);
check('shouldDepart: 20pt a 5 passi, soglia 10 → NO (arriverei a 17.5)',
      shouldDepart(20, 5, 10, b1) === false);
check('shouldDepart: 12pt a 5 passi, soglia 10 → SÌ (arriverei a 9.5)',
      shouldDepart(12, 5, 10, b1) === true);

// ── 2. Deliver troppo presto → continua a raccogliere ───────────────────────
const b2 = freshBeliefs();
const rules2 = {};
installRule({ type: 'max_parcel_reward', value: 10 }, rules2, b2);
b2.carriedParcels = [{ id: 'rich', reward: 30 }];
b2.parcels.set('w1', { id: 'w1', x: 2, y: 2, reward: 28, carriedBy: null }); // in finestra [25,30]
let p = applyRulesToPredicate(['deliver', 9, 0], rules2, b2);
check('timer: deliver a 30pt → redirect verso pickup in finestra',
      p[0] === 'go_pick_up' && p[3] === 'w1');

// ── 3. Deliver al momento giusto → passa ─────────────────────────────────────
const b3 = freshBeliefs();
const rules3 = {};
installRule({ type: 'max_parcel_reward', value: 10 }, rules3, b3);
b3.carriedParcels = [{ id: 'ripe', reward: 12 }];   // 9 passi → -4.5 → 7.5 ≤ 10
p = applyRulesToPredicate(['deliver', 9, 0], rules3, b3);
check('timer: deliver a 12pt (arrivo a 7.5) → consegna permessa', p[0] === 'deliver');

// ── 4. Pickup fuori finestra → redirect su pacco in finestra ─────────────────
const b4 = freshBeliefs();
const rules4 = {};
installRule({ type: 'max_parcel_reward', value: 10 }, rules4, b4);
b4.carriedParcels = [{ id: 'top', reward: 20 }];            // finestra [15,20]
b4.parcels.set('low', { id: 'low', x: 1, y: 1, reward: 5,  carriedBy: null });  // fuori
b4.parcels.set('ok',  { id: 'ok',  x: 3, y: 3, reward: 18, carriedBy: null });  // dentro
p = applyRulesToPredicate(['go_pick_up', 1, 1, 'low', 5], rules4, b4);
check('timer: pickup 5pt fuori finestra [15,20] → redirect su 18pt',
      p[0] === 'go_pick_up' && p[3] === 'ok');

// ── 5. Senza decay: fallback v1 (pacchi ricchi spariscono dai beliefs) ───────
const b5 = freshBeliefs();
b5.config.GAME.parcels.decaying_event = 'infinite';
const rules5 = {};
installRule({ type: 'max_parcel_reward', value: 10 }, rules5, b5);
b5.parcels.set('rich', { id: 'rich', x: 2, y: 2, reward: 50, carriedBy: null });
b5.parcels.set('poor', { id: 'poor', x: 3, y: 3, reward: 8,  carriedBy: null });
applyRulesToBeliefs(rules5, b5);
check('no-decay: pacco da 50pt rimosso, da 8pt tenuto',
      !b5.parcels.has('rich') && b5.parcels.has('poor'));

// ── 6. forbidden_tile = muro ─────────────────────────────────────────────────
const b6 = freshBeliefs();
const rules6 = {};
const msg = installRule({ type: 'forbidden_tile', tiles: [[5, 7], [9, 0]] }, rules6, b6);
check('forbidden: tile (5,7) murata (type 0)', b6.mapTiles.get('5_7').type === '0');
check('forbidden: la delivery (9,0) murata sparisce dalle delivery',
      !b6.deliveryPoints.some(d => d.x === 9 && d.y === 0));
console.log(`   (${msg})`);
// pacco spawnato sopra una tile murata → irraggiungibile → via dai beliefs
b6.parcels.set('px', { id: 'px', x: 5, y: 7, reward: 10, carriedBy: null });
applyRulesToBeliefs(rules6, b6);
check('forbidden: pacco sopra la tile murata rimosso dai beliefs', !b6.parcels.has('px'));

console.log(`\n${fail === 0 ? '🎉' : '⚠️'}  ${pass} ok, ${fail} falliti`);
process.exit(fail === 0 ? 0 : 1);
