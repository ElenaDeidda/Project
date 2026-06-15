// beliefs.js — Stato del mondo e funzioni di aggiornamento
import { smartDist, parseIntervalMs } from './basic_functions.js';

// ─── Modello di credenze "with uncertainty" (slide del prof) ──────────────────
// Ogni pacco fuori vista porta una confidenza P(esiste ancora) che DECADE nel
// tempo e viene rivista in stile bayesiano. Costanti tarabili:
const CONF_LAMBDA        = Math.LN2 / 10000;  // half-life 10s di P(esiste) fuori vista
const SENSOR_RELIABILITY = 0.9;               // P(vedo il pacco | è nel raggio ed esiste)
const ENEMY_NEAR_DIST    = 5;                 // un nemico entro questa distanza dal pacco…
const ENEMY_DECAY_MULT   = 4;                 // …fa decadere P(esiste) 4× più in fretta
const CONF_EPS           = 0.05;              // sotto questa confidenza il pacco è "perso"
const CONF_DEBUG         = true;              // ⇦ metti false per zittire i log [CONF]

export const beliefs = {
    me:             { id: '', name: '', teamId: '', teamName: '', x: 0, y: 0, score: 0 },
    config:         {},
    mapTiles:       new Map(),
    isDirectionalMap: false,
    deliveryPoints: [],
    parcels:        new Map(),
    agents:         new Map(),   // id → { x, y, moving, direction, targetX, targetY }
    carrying:       false,
    carriedParcels: [],

    // Precalcolato in updateMap():
    // per ogni spawn tile "x_y" → quante spawn tiles sono visibili da quel punto
    spawnVisibility: new Map(),

    // Stato di coordinamento di team (livello 3). Inizializzato da
    // coordination.js → initCoordination(). null = nessun coordinamento attivo.
    //   frozen:   true → il loop BDI non si muove (red light)
    //   override: predicate forzata da eseguire al posto della deliberazione
    //   role:     'collector' | 'postman' | null (staffetta, task 2)
    coord: null,

};

export function updateConfig(config) {
    beliefs.config = config;
}

export function updateMap(width, height, tiles) {
    // Reset: onMap arriva con la mappa COMPLETA (anche a ogni restart partita).
    // Senza azzerare, mapTiles/deliveryPoints/spawnVisibility si ACCUMULEREBBERO
    // tra una partita e l'altra (es. delivery_points duplicati) → pathfinding
    // confuso. Ricostruiamo da zero ogni volta.
    beliefs.mapTiles.clear();
    beliefs.deliveryPoints.length = 0;
    beliefs.spawnVisibility.clear();
    beliefs.isDirectionalMap = false;

    // --- 1. Costruisce mapTiles e deliveryPoints ---
    const ARROW_TYPES = new Set(['→', '←', '↑', '↓']);
    for (const tile of tiles) {
        const key = `${tile.x}_${tile.y}`;
        beliefs.mapTiles.set(key, { type: String(tile.type) });
        if (tile.type == '2') beliefs.deliveryPoints.push({ x: tile.x, y: tile.y });   
        if (ARROW_TYPES.has(tile.type)) beliefs.isDirectionalMap = true;
        //console.log(`[BELIEFS] isDirectionalMap = ${beliefs.isDirectionalMap}`);
        
    }

    // --- 2. Precalcola spawnVisibility ---
    const obsDist = beliefs.config.GAME?.player?.observation_distance ?? 5;

    for (const [key, tile] of beliefs.mapTiles.entries()) {
        if (tile.type != '1') continue;

        const [x, y] = key.split('_').map(Number);
        let count = 0;

        for (const [k2, t2] of beliefs.mapTiles.entries()) {
            if (t2.type != '1') continue;
            const [sx, sy] = k2.split('_').map(Number);
            if (Math.abs(sx - x) + Math.abs(sy - y) < obsDist) count++;
        }

        beliefs.spawnVisibility.set(key, count);
        //console.log(`[BELIEFS] spawnVisibility (${x},${y}) = ${count}`);
    }

    //console.log(`[BELIEFS] spawnVisibility calcolata per ${beliefs.spawnVisibility.size} spawn tiles`);
}


// ─────────────────────────────────────────────────────────────────────────────
// Stampa "umana" della mappa con le COORDINATE, per capire il sistema di numeri.
// Convenzione del server: origine (0,0) in BASSO a SINISTRA, x cresce verso
// destra, y cresce verso l'alto → disegniamo le righe da ymax (in alto) a ymin.
// Funzione PURA: ritorna una stringa multilinea (l'I/O lo fa il chiamante).
// ─────────────────────────────────────────────────────────────────────────────
export function formatMap(beliefs) {
    const tiles = beliefs.mapTiles;
    if (!tiles || tiles.size === 0) return '[MAP] mappa non ancora caricata';

    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (const key of tiles.keys()) {
        const [x, y] = key.split('_').map(Number);
        if (x < xmin) xmin = x; if (x > xmax) xmax = x;
        if (y < ymin) ymin = y; if (y > ymax) ymax = y;
    }

    const ARROWS = new Set(['→', '←', '↑', '↓']);
    const symFor = (type) => {
        switch (type) {
            case '0':  return '#';   // muro
            case '1':  return 'S';   // spawner pacchi
            case '2':  return 'D';   // delivery
            case '3':  return '·';   // calpestabile
            case '4':  return 'B';   // base
            case '5':
            case '5!': return '▒';   // crate
            default:   return ARROWS.has(type) ? type : '?';
        }
    };

    const mex = Math.round(beliefs.me?.x ?? NaN);
    const mey = Math.round(beliefs.me?.y ?? NaN);

    // Tile vietate (forbidden_tile): mostrate come 'X' anche se ora sono muri.
    const forbidden = beliefs.forbiddenTiles instanceof Map ? beliefs.forbiddenTiles : null;
    const isForbidden = (x, y) => !!forbidden && forbidden.has(`${x}_${y}`);

    const yLabelW = Math.max(String(ymin).length, String(ymax).length);
    const margin  = ' '.repeat(yLabelW + 1);
    const padY    = (y) => String(y).padStart(yLabelW, ' ');

    const lines = [];
    lines.push(`[MAP] dimensioni ${xmax - xmin + 1}×${ymax - ymin + 1} — x ${xmin}..${xmax}, y ${ymin}..${ymax} — ${tiles.size} tile — direzionale=${!!beliefs.isDirectionalMap}`);
    lines.push(`[MAP] origine (0,0) in BASSO a SINISTRA · x → destra · y ↑ alto`);
    lines.push(`[MAP] legenda: @=tu  X=vietata(muro)  D=delivery  S=spawn pacchi  #=muro  ·=calpestabile  B=base  ▒=crate  (vuoto=ignoto)`);

    // Intestazione X: riga delle decine (se serve) + riga delle unità, allineate.
    if (xmax >= 10) {
        let tens = '';
        for (let x = xmin; x <= xmax; x++) tens += (x >= 10 ? String(Math.floor(x / 10) % 10) : ' ');
        lines.push(margin + tens);
    }
    let units = '';
    for (let x = xmin; x <= xmax; x++) units += String(((x % 10) + 10) % 10);
    lines.push(margin + units);

    // Righe dall'ALTO (ymax) al BASSO (ymin), così la stampa rispetta il "su/giù".
    for (let y = ymax; y >= ymin; y--) {
        let row = '';
        for (let x = xmin; x <= xmax; x++) {
            if (x === mex && y === mey)  { row += '@'; continue; }
            if (isForbidden(x, y))       { row += 'X'; continue; }
            const t = tiles.get(`${x}_${y}`);
            row += t ? symFor(t.type) : ' ';
        }
        lines.push(`${padY(y)} ${row}`);
    }

    const dps = beliefs.deliveryPoints ?? [];
    lines.push(`[MAP] tu @ (${mex},${mey})`);
    lines.push(`[MAP] delivery_points (${dps.length}): ${dps.map(d => `(${d.x},${d.y})`).join(' ') || 'nessuno'}`);
    if (forbidden && forbidden.size > 0) {
        lines.push(`[MAP] tile vietate (${forbidden.size}): ${[...forbidden.keys()].map(k => `(${k.replace('_', ',')})`).join(' ')}`);
    }

    return lines.join('\n');
}

export function updateSensing(sensing) {
    const now    = Date.now();
    const obsDist = beliefs.config.GAME?.player?.observation_distance ?? 5;
    const decayMs = parseIntervalMs(beliefs.config.GAME?.parcels?.decaying_event);

    // --- 1. Aggiorna/inserisce i pacchi visti ORA ---
    const seen = new Set();
    for (const p of sensing.parcels) {
        // Pacco in mano a un avversario: rimuovilo dalla memoria
        if (p.carriedBy && p.carriedBy !== beliefs.me.id) {
            beliefs.parcels.delete(p.id);
            continue;
        }
        seen.add(p.id);
        const prev = beliefs.parcels.get(p.id);
        if (CONF_DEBUG && prev && (prev.confidence ?? 1) < 1)
            console.log(`[CONF] ${p.id} @(${p.x},${p.y}) RIVISTO → confidence ripristinata 1.00 (era ${(prev.confidence).toFixed(2)})`);
        beliefs.parcels.set(p.id, {
            id: p.id, x: p.x, y: p.y,
            reward: p.reward, carriedBy: p.carriedBy ?? null,
            lastDecay: now,            // ultimo istante in cui ho scontato il decay
            confidence: 1,             // visto ORA → P(esiste)=1 (modello "with uncertainty")
            lastSeen: now,
            lastConfUpdate: now,
        });
    }

    // Aggiorna gli agenti PRIMA della riconciliazione pacchi, così la confidenza
    // può tener conto dei nemici vicini (last-known position).
    updateAgents(sensing.agents ?? []);

    // --- 2. Riconcilia i pacchi NON visti in questo tick (memoria) ---
    // Senza questo passo un pacco che esce dalla vista sparirebbe subito,
    // facendo perdere il commitment all'agente → oscillazione tra due target.
    // Modello "with uncertainty": invece di cancellare di colpo, manteniamo una
    // confidenza P(esiste) che decade nel tempo e viene rivista in stile bayesiano.
    for (const [id, p] of beliefs.parcels) {
        if (seen.has(id)) continue;

        // Reward ATTESO: continua a scontare il decay di gioco (= valore SE esiste).
        if (Number.isFinite(decayMs)) {
            p.reward   -= (now - p.lastDecay) / decayMs;
            p.lastDecay = now;
            if (p.reward <= 0) { beliefs.parcels.delete(id); continue; }
        }

        // 1) Decadimento temporale di P(esiste). Più veloce se un nemico è vicino
        //    al pacco (può averlo già raccolto). "Visto tanto tempo fa → P bassa".
        const cStart = p.confidence ?? 1;
        const dt = now - (p.lastConfUpdate ?? now);
        p.lastConfUpdate = now;
        let lambda = CONF_LAMBDA, enemyDist = null;
        for (const a of beliefs.agents.values()) {
            const d = smartDist(a, p);
            if (d <= ENEMY_NEAR_DIST) { lambda *= ENEMY_DECAY_MULT; enemyDist = d; break; }
        }
        let c = cStart * Math.exp(-lambda * dt);
        const cAfterTime = c;

        // 2) Dentro il raggio di osservazione ma NON lo vedo → forte evidenza che
        //    non c'è più: revisione bayesiana  P(E|¬Seen)=P(¬Seen|E)·P(E)/P(¬Seen),
        //    con P(¬Seen|E)=1−affidabilità sensore e P(¬Seen|¬E)=1.
        const myDist = smartDist(beliefs.me, p);
        const inRange = myDist < obsDist;
        if (inRange) {
            const pNsE = 1 - SENSOR_RELIABILITY;
            c = (pNsE * c) / (pNsE * c + (1 - c));
        }

        p.confidence = c;

        if (CONF_DEBUG) {
            const why = [];
            why.push(`temporale ${cStart.toFixed(2)}→${cAfterTime.toFixed(2)} (Δt=${dt}ms)`);
            if (enemyDist !== null) why.push(`nemico a ${enemyDist} → decay ×${ENEMY_DECAY_MULT}`);
            if (inRange)           why.push(`IN-RANGE non visto (dist ${myDist}≤${obsDist}) → bayes ${cAfterTime.toFixed(2)}→${c.toFixed(2)}`);
            console.log(`[CONF] ${id} @(${p.x},${p.y}) fuori-vista: ${why.join(' | ')}  ⇒ confidence=${c.toFixed(2)}${c < CONF_EPS ? ' ✗ PERSO (rimosso)' : ''}`);
        }

        if (c < CONF_EPS) beliefs.parcels.delete(id);   // confidenza troppo bassa → "perso"
    }

    //console.log(`[updateSensing] parcels visibili:`, seen.size, `| in memoria:`, beliefs.parcels.size - seen.size);
    // console.log(`[updateSensing] parcels:`, [...beliefs.parcels.values()]);

    const mine = sensing.parcels.filter(p => p.carriedBy === beliefs.me.id);
    beliefs.carrying       = mine.length > 0;
    beliefs.carriedParcels = mine;

    // Valore di OGNI pacco AL MOMENTO DELLA RACCOLTA (per il fallback "consegna
    // comunque" dello stack: consegna se un pacco è sceso del N% del suo valore
    // originale). Registriamo alla prima volta che lo vediamo in mano e puliamo
    // gli id non più portati (consegnati/scaricati).
    beliefs.collectedReward ??= new Map();
    const carriedIds = new Set(mine.map(p => p.id));
    for (const p of mine)
        if (!beliefs.collectedReward.has(p.id)) beliefs.collectedReward.set(p.id, p.reward);
    for (const id of beliefs.collectedReward.keys())
        if (!carriedIds.has(id)) beliefs.collectedReward.delete(id);
    // console.log(`[updateSensing] carrying:`, beliefs.carrying);
    //console.log(`[updateSensing] carriedParcels:`, beliefs.carriedParcels);
    // NB: updateAgents è già stato chiamato sopra (prima della riconciliazione pacchi).
}

export function updateAgents(agents) {
    beliefs.agents.clear();

    for (const a of agents) {
        if (a.x == null || a.y == null) continue;

        const fracX = a.x % 1;
        const fracY = a.y % 1;
        const moving = fracX !== 0 || fracY !== 0;

        let direction = 'none';
        let targetX   = Math.round(a.x);
        let targetY   = Math.round(a.y);

        if (moving) {
            if (fracX > 0.5)       { direction = 'right'; targetX = Math.floor(a.x) + 1; }
            else if (fracX > 0)    { direction = 'left';  targetX = Math.floor(a.x);     }
            else if (fracY > 0.5)  { direction = 'up';    targetY = Math.floor(a.y) + 1; }
            else if (fracY > 0)    { direction = 'down';  targetY = Math.floor(a.y);     }
        }

        beliefs.agents.set(a.id, {
            x: a.x, y: a.y,
            moving, direction,
            targetX, targetY,
            teamId: a.teamId ?? null,                       // per distinguere alleati/nemici
            isTeammate: !!(a.teamId && a.teamId === beliefs.me.teamId),
        });

        //console.log(`[updateAgents] "${a.name}" (${a.id}) @ (${a.x},${a.y}) moving:${moving} dir:${direction} → target:(${targetX},${targetY})`);
    }

    //console.log(`[updateAgents] agenti tracciati:`, beliefs.agents.size);
}

export function getBlockedCells() {
    const blocked = new Set();
    for (const a of beliefs.agents.values()) {
        blocked.add(`${Math.round(a.x)}_${Math.round(a.y)}`);
        blocked.add(`${a.targetX}_${a.targetY}`);
    }
    //console.log(`[getBlockedCells] celle bloccate:`, blocked.size);
    return blocked;
}

export function getAgentPositions() {
    const out = [];
    for (const a of beliefs.agents.values()) {
        out.push({ x: Math.round(a.x), y: Math.round(a.y) });
        if (a.moving) out.push({ x: a.targetX, y: a.targetY });
    }
    //console.log(`[getAgentPositions] posizioni note:`, out);
    return out;
}

// Compagno di team attualmente visibile (o null). Usato dal coordinamento di
// livello 3 per sapere dove si trova l'alleato (es. attesa "incontro" staffetta).
export function getTeammateAgent() {
    for (const a of beliefs.agents.values()) if (a.isTeammate) return a;
    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Quali pacchi consegnare DAVVERO in base alle regole attive (beliefs.activeRules,
// impostato dal processo LLM; in main.js è undefined → si consegna tutto):
//   - max_deliver_reward = T → solo i pacchi che valgono ≤ T (consegnarne uno > T
//     darebbe 0 → lo si tiene finché decade nel range);
//   - stack_size = N         → al massimo N (i più ricchi tra i consegnabili);
//   - nessuna regola         → tutti i pacchi portati.
// Ritorna la lista di id da passare a emitPutdown.
// ─────────────────────────────────────────────────────────────────────────────
export function deliverableIds(beliefs) {
    let parcels = beliefs.carriedParcels ?? [];
    const T = beliefs.activeRules?.maxDeliverReward;
    if (typeof T === 'number') parcels = parcels.filter(p => (p.reward ?? 0) <= T);
    const N = beliefs.activeRules?.stackSize;
    if (Number.isInteger(N) && parcels.length >= N) {
        parcels = [...parcels].sort((a, b) => (b.reward ?? 0) - (a.reward ?? 0)).slice(0, N);
    }
    return parcels.map(p => p.id);
}
