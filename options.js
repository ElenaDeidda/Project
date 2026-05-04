// options.js — Generazione opzioni e deliberazione
import { beliefs } from './beliefs.js';
import { smartDist, scoreParcel } from './basic_functions.js';

export function generateOptions() {
    const options = [];
    
    // 1. Cerca pacchi SEMPRE, a meno che lo "zaino" non sia pieno (es. limite di 3 pacchi)
    if (beliefs.carriedParcels.length < 3) {
        for (const [id, parcel] of beliefs.parcels.entries()) {
            console.log("parcel.carriedBy: ", parcel.carriedBy)
            if (parcel.carriedBy) continue;
            const score = scoreParcel(beliefs.me, parcel); 
            options.push(['go_pick_up', parcel.x, parcel.y, id, score]);
        }
    } 
    
    // 2. Valuta la consegna SEMPRE, purché abbiamo almeno 1 pacco in mano
    if (beliefs.carriedParcels.length > 0) {
        for (const dp of beliefs.deliveryPoints) {
            options.push(['deliver', dp.x, dp.y, smartDist(beliefs.me, dp)]);
        }
    }

    // 3. Se non ci sono opzioni utili, la priorità diventa pattugliare le zone di spawn
    options.push(['patrol_spawn']);
    console.log("[Options to choose between]: ", options)
    return options;
}

export function deliberate(options) {
    const SCORE_MIN   = -100;
    const pickupOpts  = options.filter(o => o[0] === 'go_pick_up');
    const deliverOpts = options.filter(o => o[0] === 'deliver');

    // === CASO 1: HO GIÀ DEI PACCHI IN MANO ===
    if (beliefs.carriedParcels.length > 0) {
        
        // Controllo Emergenza: c'è un pacco nello zaino che sta per morire?
        let emergency = false;
        for (const p of beliefs.carriedParcels) {
            // Se la vita di un pacco in mano scende sotto i 15 tick, allarme rosso!
            if (p.reward < 15) {
                emergency = true;
                break;
            }
        }

        // Se lo zaino è pieno (3 pacchi) O c'è un'emergenza, VAI SUBITO A CONSEGNARE
        if (beliefs.carriedParcels.length >= 3 || emergency) {
            return deliverOpts.reduce((b, c) => c[3] < b[3] ? c : b); // Sceglie il delivery point più vicino
        }

        // Se non c'è emergenza e c'è spazio, vediamo se c'è un OTTIMO pacco da aggiungere
        if (pickupOpts.length > 0) {
            const bestPickup = pickupOpts.reduce((b, c) => c[4] > b[4] ? c : b);
            
            // Raccogliamo un pacco extra SOLO se ha un punteggio buono (> 0)
            // Se vale poco o è lontano, non rischiamo e andiamo a consegnare
            if (bestPickup[4] > 0) { 
                return bestPickup;
            }
        }

        // Se i pacchi rimasti a terra fanno schifo (score basso), vado a consegnare quello che ho
        return deliverOpts.reduce((b, c) => c[3] < b[3] ? c : b);
    }

    // === CASO 2: HO LE MANI VUOTE ===
    if (pickupOpts.length > 0) {
        const best = pickupOpts.reduce((b, c) => c[4] > b[4] ? c : b);
        if (best[4] >= SCORE_MIN) return best;
    }

    // === CASO 3: NESSUN PACCO VISTO, NESSUN PACCO IN MANO ===
    return ['patrol_spawn'];
}