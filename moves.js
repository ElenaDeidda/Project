import { getDirection, bfsPath } from './basic_functions.js';

export async function navigateTo(
    me,
    target,
    socket,
    walkableTiles,
    shouldStop = () => false,
    retryLimit = 3
) {
    for (let attempt = 0; attempt < retryLimit; attempt++) {
        const path = bfsPath(me, target, walkableTiles);

        if (!path) return 'failed';
        if (path.length === 0) return 'reached';

        let pathBroken = false;

        for (const nextCell of path) {
            if (shouldStop()) return 'stopped';

            const direction = getDirection(me, nextCell);
            if (!direction) continue;

            // Il socket.emitMove gestisce già i tempi fisici del server!
            const result = await socket.emitMove(direction);

            if (result && result.x != null) {
                me.x = result.x;
                me.y = result.y;
                
                // Controllo anti-desync (impedisce di camminare sui muri se il server rifiuta il passo)
                if (Math.round(me.x) !== nextCell.x || Math.round(me.y) !== nextCell.y) {
                    console.warn(`[MOVES] Desync! Ricalcolo percorso...`);
                    pathBroken = true;
                    break;
                }
            } else {
                // Se il movimento fallisce (es. server occupato), facciamo una mini-pausa e ricalcoliamo
                await new Promise(r => setTimeout(r, 100));
                pathBroken = true;
                break;
            }
        }

        if (!pathBroken) {
            const arrived = Math.round(me.x) === Math.round(target.x) &&
                            Math.round(me.y) === Math.round(target.y);
            return arrived ? 'reached' : 'failed';
        }
    }
    
    return 'failed';
}