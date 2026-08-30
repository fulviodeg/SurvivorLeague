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
 * confronta `win_only` e, dalla feature AUTOPICK, anche `autopick_on_missing`
 * (stessa funzione, una chiave in più): è estensibile per chiave ai futuri
 * parametri di modalità (es. `JOLLIES_PER_PLAYER`) SENZA una seconda guardia —
 * basta aggiungere un confronto nella stessa funzione.
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
 * Modalità di gioco (ADR-016 win_only + feature JOLLY): oggetto ESTENSIBILE
 * che descrive la modalità attiva del torneo, derivato dalla configurazione
 * UNA volta nel punto di iniezione (mai `getConfig()` nei moduli).
 *
 * `winOnly` (ADR-016): il giocatore sceglie SOLO la squadra vincente
 * (outcome sempre 'win'); pareggio/sconfitta = pick sbagliato.
 *
 * `jollyEnabled` (feature JOLLY): i jolly sono attivi (win_only E
 * `JOLLIES_PER_PLAYER >= 1`). Il Jolly salva dall'eliminazione in caso di
 * PAREAGGIO (non dalla sconfitta); si dichiara nel pick con la keyword
 * "jolly" ed è bruciato alla dichiarazione.
 *
 * Destinato a CRESCERE con le future feature di `win_only`: ogni nuovo
 * parametro di modalità aggiunge un campo qui (unico punto di derivazione),
 * con la factory `modeFor` e — per i parametri FISSATI nel DB — un confronto
 * nella stessa `assertModeConsistent`.
 */
export interface GameMode {
  /** true = modalità win_only (ADR-016). */
  winOnly: boolean;
  /** true = jolly attivi (win_only && JOLLIES_PER_PLAYER >= 1). */
  jollyEnabled: boolean;
}

/**
 * Factory pura della modalità di gioco: deriva `GameMode` dai parametri di
 * configurazione. `jollyEnabled` è attivo SOLO in win_only (in classica il
 * pareggio è già esito corretto, il jolly non ha effetto) e con almeno un
 * jolly per giocatore (`JOLLIES_PER_PLAYER >= 1`; 0 = feature off).
 */
export function modeFor(winOnly: boolean, jolliesPerPlayer: number): GameMode {
  return { winOnly, jollyEnabled: winOnly && jolliesPerPlayer >= 1 };
}

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

  const persistedWinOnly = state.win_only === 1;
  const configuredWinOnly = ctx.config.WIN_ONLY;
  // Feature AUTOPICK: speculare a win_only — la persistenza si confronta col
  // valore .env corrente INDIPENDENTEMENTE da WIN_ONLY (con WIN_ONLY=false il
  // valore viene comunque persistito, la sola derivazione lo ignora, D5).
  const persistedAutopick = state.autopick_on_missing === 1;
  const configuredAutopick = ctx.config.AUTOPICK_ON_MISSING;
  // Feature JOLLY: speculare a win_only/autopick — il numero di jolly per
  // giocatore è persistito a tournament:start (config.JOLLIES_PER_PLAYER) e si
  // confronta col valore .env corrente (interi, non booleani).
  const persistedJollies = state.jollies_per_player;
  const configuredJollies = ctx.config.JOLLIES_PER_PLAYER;

  if (
    persistedWinOnly === configuredWinOnly &&
    persistedAutopick === configuredAutopick &&
    persistedJollies === configuredJollies
  ) {
    return;
  }

  const parts: string[] = [];
  if (persistedWinOnly !== configuredWinOnly) {
    parts.push(
      `WIN_ONLY cambiata a torneo aperto: persistita ${persistedWinOnly ? 'true' : 'false'} ` +
        `nel DB (tournament_state.win_only=${state.win_only}), configurata ${configuredWinOnly ? 'true' : 'false'} ` +
        `in WIN_ONLY.`
    );
  }
  if (persistedAutopick !== configuredAutopick) {
    parts.push(
      `AUTOPICK_ON_MISSING cambiata a torneo aperto: persistita ${persistedAutopick ? 'true' : 'false'} ` +
        `nel DB (tournament_state.autopick_on_missing=${state.autopick_on_missing}), configurata ${configuredAutopick ? 'true' : 'false'} ` +
        `in AUTOPICK_ON_MISSING.`
    );
  }
  if (persistedJollies !== configuredJollies) {
    parts.push(
      `JOLLIES_PER_PLAYER cambiata a torneo aperto: persistito ${persistedJollies} ` +
        `nel DB (tournament_state.jollies_per_player=${state.jollies_per_player}), configurato ${configuredJollies} ` +
        `in JOLLIES_PER_PLAYER.`
    );
  }
  const message =
    `${parts.join(' ')} La modalità è fissata a tournament:start: ripristina i valori nel .env ` +
    `oppure chiudi il torneo e riavvia con tournament:start.`;
  ctx.logger?.fatal(
    {
      persisted: persistedWinOnly,
      configured: configuredWinOnly,
      winOnly: state.win_only,
      persistedAutopick,
      configuredAutopick,
      autopickOnMissing: state.autopick_on_missing,
      persistedJollies,
      configuredJollies,
      jolliesPerPlayer: state.jollies_per_player
    },
    'game mode mismatch: aborting'
  );
  throw new Error(message);
}
