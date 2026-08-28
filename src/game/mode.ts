/**
 * Guardia di consistenza della modalità di gioco (ADR-016, win_only).
 *
 * Ruolo: rileva un cambio di `WIN_ONLY` (o, in futuro, di un qualunque
 * parametro di modalità fissato nel DB) a torneo APERTO e ABORTA il processo
 * con un errore fatale. La modalità di gioco è scelta a `tournament:start` e
 * persistita in `tournament_state` (qui `win_only`); cambiarla in `.env` a
 * torneo in corso produrrebbe uno stato incoerente (pick registrati con una
 * semantica e valutati con un'altra), quindi il sistema si ferma PRIMA di
 * qualsiasi scrittura/invio: la guardia è SOLA LETTURA e precede le scritture.
 *
 * Nome GENERICO `assertModeConsistent` (non `assertWinOnlyConsistent`):
 * oggi confronta solo `win_only`, ma è estensibile per chiave ai futuri
 * parametri di modalità (es. `JOLLIES_PER_PLAYER`) SENZA una seconda guardia —
 * basta aggiungere un confronto nella stessa funzione (vedi piano win_only,
 * sezione Jolly, punto 1).
 *
 * Meccanismo fatale (verificato sulla CLI): i comandi che scrivono/inviano
 * (`scheduler:tick`, `channel:email:process`, `round:open/close/score`) non
 * assorbono questo errore nei loro try/catch per-azione/per-messaggio — il
 * `throw` qui sotto esce dal comando, arriva a yargs (stderr + exit non-zero)
 * e nel cron finisce nel log (`>> …/survivor.log 2>&1`). La guardia quindi:
 * (a) `ctx.logger?.fatal({persisted, configured}, …)` quando il logger è
 *     presente nel contesto (log strutturato, in inglese);
 * (b) `throw new Error(...)` SEMPRE — il throw è il meccanismo primario di
 *     arresto del processo, indipendente dalla presenza del logger.
 *
 * Interazioni: usata come hook all'INIZIO dei percorsi che SCRIVONO o INVIANO
 * email — `schedulerTick` (scheduler.ts), `processEmailBatch`
 * (channel/email-processor.ts), `openRound`/`closeRound`/`scoreRound`
 * (round-manager.ts) e, in difesa in profondità, `validatePick`
 * (pick-processor.ts). I comandi read-only e `tournament:start` (il punto che
 * SCRIVE la modalità) NON sono guardati.
 */
import type { GameContext } from './context.js';
import { getTournamentState } from './tournament.js';

/**
 * Verifica che la modalità di gioco persistita in `tournament_state` coincida
 * con la configurazione corrente, a torneo APERTO. No-op se il torneo non è
 * avviato (`season_started !== 1`), se è CHIUSO (`winner_notified === 1` — il
 * riavvio via `tournament:start` riscrive la modalità dal nuovo `.env`) o se i
 * valori coincidono. Altrimenti logga `fatal` (se il logger è presente) e
 * LANCIA un errore che nomina `WIN_ONLY` e i valori persistito vs configurato:
 * il throw propaga fuori dal comando (stderr + exit non-zero, cron nel log).
 */
export function assertModeConsistent(ctx: GameContext): void {
  const state = getTournamentState(ctx.db);
  if (state === undefined || state.season_started !== 1) return;
  if (state.winner_notified === 1) return;

  const persisted = state.win_only === 1;
  const configured = ctx.config.WIN_ONLY;
  if (persisted === configured) return;

  const message =
    `WIN_ONLY cambiata a torneo aperto: persistita ${persisted ? 'true' : 'false'} ` +
    `nel DB (tournament_state.win_only=${state.win_only}), configurata ${configured ? 'true' : 'false'} ` +
    `in WIN_ONLY. La modalità è fissata a tournament:start: ripristina WIN_ONLY=${persisted ? 'true' : 'false'} ` +
    `oppure chiudi il torneo e riavvia con tournament:start.`;
  ctx.logger?.fatal({ persisted, configured, winOnly: state.win_only }, 'game mode mismatch: aborting');
  throw new Error(message);
}
