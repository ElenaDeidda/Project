// beliefs.js — Stato del mondo e funzioni di aggiornamento
import { smartDist, parseIntervalMs } from './basic_functions.js';

export const beliefs = {
    me:             { id: '', name: '', teamId: '', teamName: '', x: 0, y: 0, score: 0 },
    config:         {},
    mapTiles:       new Map(),
    isDirectionalMap: false,
    isCrateMap:     false,
    crateTiles:     new Map(),   // "x_y" → {x, y}
    deliveryPoints: [],
    parcels:        new Map(),
    agents:         new Map(),   // id → { x, y, moving, direction, targetX, targetY }
    carrying:       false,
    carriedParcels: [],

    // Precalcolato in updateMap():
    // per ogni spawn tile "x_y" → quante spawn tiles sono visibili da quel punto
    spawnVisibility: new Map(),

};

export function updateConfig(config) {
    beliefs.config = config;
}

export function updateMap(width, height, tiles) {
    // --- 1. Costruisce mapTiles e deliveryPoints ---
    const ARROW_TYPES = new Set(['→', '←', '↑', '↓']);
    for (const tile of tiles) {
        const key = `${tile.x}_${tile.y}`;
        beliefs.mapTiles.set(key, { type: String(tile.type) });
        if (tile.type == '2') beliefs.deliveryPoints.push({ x: tile.x, y: tile.y });   
        if (ARROW_TYPES.has(tile.type)) beliefs.isDirectionalMap = true;
        if (tile.type === '5!' || tile.type === '5') {
            beliefs.isCrateMap = true;
        }
        if (tile.type === '5!') {
            beliefs.crateTiles.set(key, { x: tile.x, y: tile.y });
        }
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
            case '5!': return '[]';   // crate
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
        beliefs.parcels.set(p.id, {
            id: p.id, x: p.x, y: p.y,
            reward: p.reward, carriedBy: p.carriedBy ?? null,
            lastDecay: now,            // ultimo istante in cui ho scontato il decay
        });
    }

    // --- 2. Riconcilia i pacchi NON visti in questo tick (memoria) ---
    // Senza questo passo un pacco che esce dalla vista sparirebbe subito,
    // facendo perdere il commitment all'agente → oscillazione tra due target.
    for (const [id, p] of beliefs.parcels) {
        if (seen.has(id)) continue;

        // Se è dentro il raggio di osservazione ma non lo vediamo → preso/scaduto
        if (smartDist(beliefs.me, p) < obsDist) {
            beliefs.parcels.delete(id);
            continue;
        }

        // Fuori vista: scontiamo il reward per il decay maturato dall'ultimo conteggio
        if (Number.isFinite(decayMs)) {
            p.reward  -= (now - p.lastDecay) / decayMs;
            p.lastDecay = now;
            if (p.reward <= 0) beliefs.parcels.delete(id)
        }

    }

    //console.log(`[updateSensing] parcels visibili:`, seen.size, `| in memoria:`, beliefs.parcels.size - seen.size);
    // console.log(`[updateSensing] parcels:`, [...beliefs.parcels.values()]);

    const mine = sensing.parcels.filter(p => p.carriedBy === beliefs.me.id);
    beliefs.carrying       = mine.length > 0;
    beliefs.carriedParcels = mine;
    // console.log(`[updateSensing] carrying:`, beliefs.carrying);
    //console.log(`[updateSensing] carriedParcels:`, beliefs.carriedParcels);

    updateAgents(sensing.agents ?? []);
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

// ─────────────────────────────────────────────────────────────────────────────
// Riconcilia la posizione delle casse con lo stato reale del server.
// Va chiamata ad ogni onSensing, DOPO updateSensing().
// Usa sensing.crates se disponibile, altrimenti inferisce dalle tile visibili.
// ─────────────────────────────────────────────────────────────────────────────
export function updateCrates(sensing) {
    if (!beliefs.isCrateMap) return;

    const obsDist = beliefs.config.GAME?.player?.observation_distance ?? 5;
    const me = beliefs.me;
    const mx = Math.round(me.x);
    const my = Math.round(me.y);

    // Correzione immediata: l'agente non può fisicamente stare su una cella
    // con una cassa. Se crateTiles la marca occupata è uno stato stale
    // (es. un altro agente l'ha spostata) — rimuovila subito, non solo
    // a livello di generazione del problema PDDL.
    const selfKey = `${mx}_${my}`;
    if (beliefs.crateTiles.has(selfKey)) {
        beliefs.crateTiles.delete(selfKey);
        beliefs.mapTiles.set(selfKey, { type: '5' });
        console.log(`[BELIEFS] cassa rimossa da (${mx},${my}) — l'agente è su quella cella`);
    }

    // --- Strategia A: il server manda sensing.crates ---
    if (sensing.crates && sensing.crates.length > 0) {
        const serverCrateKeys = new Set(
            sensing.crates.map(c => `${Math.round(c.x)}_${Math.round(c.y)}`)
        );

        for (const [key, tile] of beliefs.mapTiles.entries()) {
            if (tile.type !== '5' && tile.type !== '5!') continue;
            const [x, y] = key.split('_').map(Number);
            if (Math.abs(x - mx) + Math.abs(y - my) >= obsDist) continue; // fuori vista

            const serverHasCrate = serverCrateKeys.has(key);
            const weThinkHasCrate = beliefs.crateTiles.has(key);

            if (weThinkHasCrate && !serverHasCrate) {
                beliefs.crateTiles.delete(key);
                beliefs.mapTiles.set(key, { type: '5' });
                console.log(`[BELIEFS] cassa rimossa da (${x},${y}) — riconciliazione server`);
            }
            if (!weThinkHasCrate && serverHasCrate) {
                beliefs.crateTiles.set(key, { x, y });
                beliefs.mapTiles.set(key, { type: '5!' });
                console.log(`[BELIEFS] cassa aggiunta a (${x},${y}) — riconciliazione server`);
            }
        }
        return;
    }

    // --- Strategia B: sensing.crates non disponibile → usa sensing.positions ---
    // Le positions sono le tile percorribili visibili nel raggio di osservazione.
    if (!sensing.positions || sensing.positions.length === 0) return;

    const walkableVisible = new Set(
        sensing.positions.map(p => `${Math.round(p.x)}_${Math.round(p.y)}`)
    );

    // B1: rimuovi casse in '5!' che ora sono walkable (cassa spostata via)
    // Usa snapshot per evitare problemi di modifica durante iterazione.
    for (const [key] of [...beliefs.crateTiles.entries()]) {
        const [x, y] = key.split('_').map(Number);
        if (Math.abs(x - mx) + Math.abs(y - my) >= obsDist) continue;
        if (walkableVisible.has(key)) {
            beliefs.crateTiles.delete(key);
            beliefs.mapTiles.set(key, { type: '5' });
            console.log(`[BELIEFS] cassa rimossa da (${x},${y}) — tile ora walkable (fallback positions)`);
        }
    }

    // B2: aggiungi casse in slot '5' non walkable e non occupati da agenti.
    // Un '5' nel raggio visivo che il server non riporta come walkable e non
    // è occupato da un agente noto deve avere una cassa (es. dopo restart).
    const agentKeys = new Set(
        [...beliefs.agents.values()].map(a => `${Math.round(a.x)}_${Math.round(a.y)}`)
    );
    agentKeys.add(`${mx}_${my}`); // l'agente stesso non è in beliefs.agents

    for (const [key, tile] of beliefs.mapTiles.entries()) {
        if (tile.type !== '5') continue;
        const [x, y] = key.split('_').map(Number);
        if (Math.abs(x - mx) + Math.abs(y - my) >= obsDist) continue;
        if (!walkableVisible.has(key) && !agentKeys.has(key)) {
            beliefs.crateTiles.set(key, { x, y });
            beliefs.mapTiles.set(key, { type: '5!' });
            console.log(`[BELIEFS] cassa rilevata a (${x},${y}) — slot non walkable (inferenza positions)`);
        }
    }
}