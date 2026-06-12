// dashboard_server.js — SSE server per la dashboard visuale.
// Nessuna dipendenza esterna: usa solo il modulo http built-in di Node.
//
// USO:
//   import { initDashboard, emitDashboardState } from './dashboard_server.js';
//   initDashboard(3001);                // apri http://localhost:3001
//   emitDashboardState(buildState());   // chiama ogni ~200ms

import http from 'http';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));

let _clients   = [];
let _lastState = null;

export function initDashboard(port = 3001) {
    const server = http.createServer((req, res) => {

        if (req.url === '/events') {
            res.writeHead(200, {
                'Content-Type':  'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection':    'keep-alive',
                'Access-Control-Allow-Origin': '*',
            });
            res.write(':\n\n');
            // invia subito l'ultimo stato noto al nuovo browser
            if (_lastState) res.write(`data: ${JSON.stringify(_lastState)}\n\n`);
            _clients.push(res);
            req.on('close', () => { _clients = _clients.filter(c => c !== res); });
            return;
        }

        // serve dashboard.html per qualsiasi altro percorso
        fs.readFile(path.join(__dir, 'dashboard.html'), (err, data) => {
            if (err) { res.writeHead(404); res.end('dashboard.html non trovato'); return; }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
        });
    });

    server.listen(port, () => {
        console.log(`[DASHBOARD] http://localhost:${port}`);
    });

    // keepalive: evita che i proxy chiudano la connessione SSE idle
    setInterval(() => {
        _clients = _clients.filter(c => {
            try { c.write(':\n\n'); return true; } catch { return false; }
        });
    }, 20_000);
}

export function emitDashboardState(state) {
    _lastState = state;
    if (_clients.length === 0) return;
    const msg = `data: ${JSON.stringify(state)}\n\n`;
    _clients = _clients.filter(c => {
        try { c.write(msg); return true; } catch { return false; }
    });
}
