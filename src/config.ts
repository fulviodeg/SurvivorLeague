/**
 * Configurazione centralizzata della POC (LLD §4).
 *
 * Ruolo: unico punto di accesso ai parametri di sistema. Carica le variabili
 * d'ambiente, applica i default documentati in LLD §4.1-§4.4 e nella decisione
 * 11 del piano (SIM_PLAYERS), e valida tutto con zod (LLD §4.5): se una
 * variabile richiesta manca o ha formato errato, lancia ConfigError con un
 * messaggio che nomina esplicitamente ogni variabile problematica.
 *
 * Interazioni: usata dai comandi CLI (src/cli/) e dal logger (src/logger.ts)
 * tramite getConfig(); non dipende da nessun altro modulo del progetto.
 *
 * Caricamento .env: usa process.loadEnvFile() nativo di Node ≥20.12 invece del
 * pacchetto dotenv — stessa funzionalità per il formato KEY=VALUE di .env,
 * zero dipendenze aggiuntive. Il file da caricare è selezionabile con la
 * variabile `ENV_FILE` (default `.env`): serve al test mode UAT (`.env.uat`).
 * Semantica del loader (§0.2 del piano UAT, documentata anche in LLD §4.5):
 * process.loadEnvFile NON sovrascrive le variabili già presenti in
 * process.env (come dotenv senza override), quindi un override inline
 * `VAR=x npm run cli -- ...` vince sul file. Se `ENV_FILE` è impostato ma il
 * path non esiste → ConfigError che nomina il path; il caso "nessun .env"
 * (ENV_FILE assente) resta silenzioso: in produzione le variabili arrivano
 * dall'ambiente del processo (cron).
 */
import process from 'node:process';

import { z } from 'zod';

/** Una variabile richiesta: stringa presente e non vuota. */
const required = () => z.string().min(1, 'variabile richiesta vuota o mancante');
/** Intero positivo da stringa env (es. "993" → 993); rifiuta valori non numerici. */
const intParam = () => z.coerce.number().int().positive();
/** Booleano da stringa env: accetta solo 'true' | 'false' (vedi .env.example). */
const boolParam = (defaultValue: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(defaultValue)
    .transform((v) => v === 'true');

/**
 * Offset orario unificato test-only `TEST_OFFSET_DAYS` (§0.1/D9 del piano
 * UAT): intero di GIORNI ≥ 0 applicato sia al clock (`makeNow`) sia al
 * `receivedAt` delle email quando `TEST_MODE=true` e valore > 0; 0 = offset
 * disattivato (default). Parser TOLLERANTE per il gating a consumo (§0.3):
 * un valore malformato, negativo o vuoto è ricondotto al default 0 SENZA
 * errore — i parametri test-only non devono mai far fallire l'avvio, tanto
 * più con `TEST_MODE=false` (es. env copiato per sbaglio).
 */
const testOffsetDaysParam = () =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') return 0;
      const n = Number(value);
      return Number.isInteger(n) && n >= 0 ? n : 0;
    });

/**
 * Flag test-only `TEST_REFRESH_ALLOWED` (§0.1/Task 4 del piano UAT): quando
 * `TEST_MODE=true`, se `true` consente a `data:import`/`data:refresh`/refresh
 * dello scheduler di operare (con WARN di consenso a ogni operazione),
 * altrimenti li blocca; con `TEST_MODE=false` è ignorato (gating a consumo).
 * Parser TOLLERANTE come `TEST_OFFSET_DAYS`: solo la stringa esatta 'true'
 * attiva il flag, qualunque altro valore (incluso malformato/vuoto) → false.
 */
const testRefreshAllowedParam = () =>
  z
    .string()
    .optional()
    .transform((value) => value === 'true');

/**
 * Valore di PRODUZIONE di `PLATFORM_DB_PATH` (ADR-009, RF-P7) — UNICA fonte
 * del percorso del DB piattaforma di produzione: è usata sia come default
 * zod di `PLATFORM_DB_PATH` (campo sotto) sia dalla guardia
 * `assertSimPlatformPath` di `src/cli/commands/simulate.ts` (D8/B4), che
 * rifiuta `simulate:*` quando il percorso configurato coincide con questo
 * valore. Cambiare il valore di produzione = cambiare SOLO questa costante
 * (e l'eventuale `.env` reale che la ripete); MAI duplicarla altrove: il
 * confronto della guardia resterebbe disallineato dal default reale.
 */
export const PLATFORM_DB_PATH_DEFAULT = './data/platform.db';

/**
 * Parametro fuso orario di sistema `TIMEZONE` (ADR-011 "Email v2"): stringa
 * IANA (es. `Europe/Rome`, `America/New_York`), default `Europe/Rome`.
 * VALIDATA AL BOOT con una prova di formattazione `Intl.DateTimeFormat`
 * (una stringa non-IANA produce un ConfigError chiaro che nomina la
 * variabile). Semantica: il sistema di gioco elabora SOLO istanti UTC
 * assoluti (clock iniettato); il fuso conta ESCLUSIVAMENTE quando si
 * comunica verso l'esterno — formattazione delle date nelle email
 * (src/llm/email-renderer.ts) e timestamp dei log pino (src/logger.ts).
 * Cambiarlo NON altera alcuna decisione di gioco: sposta solo le date
 * mostrate.
 */
const timezoneParam = () =>
  z
    .string()
    .min(1, 'variabile richiesta vuota o mancante')
    .default('Europe/Rome')
    .refine((value) => {
      try {
        // LOW-2: la sonda usa il locale NEUTRO 'en-US' (sempre presente anche
        // nelle build small-icu): la VALIDITÀ di una timezone IANA non dipende
        // dal locale, quindi un nodo senza dati `it-IT` non fa fallire
        // erroneamente il boot. L'output `it-IT`/`en-CA` delle email e dei log
        // richiede full-icu (Node ≥13 lo fornisce di default).
        new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
        return true;
      } catch {
        return false;
      }
    }, 'timezone IANA non valida (es. Europe/Rome, America/New_York)');

/**
 * Schema completo delle variabili d'ambiente (LLD §4 + SIM_PLAYERS).
 * I default corrispondono a quelli di .env.example: cambiare un default qui
 * richiede di aggiornare anche .env.example e LLD §4.
 */
const configSchema = z.object({
  // --- §4.1 Parametri di gioco ---
  // Anticipo (minuti) della deadline pick sul fischio d'inizio della prima partita del round.
  DEADLINE_ADVANCE_MIN: intParam().default(30),
  // Scarto (minuti) oltre la fine prevista dell'ultima partita per la chiusura del TC (finestra rinvii).
  TC_CLOSE_SKEW_MIN: intParam().default(300),
  // Durata stimata (minuti) di una partita, per calcolarne la fine prevista.
  MATCH_DURATION_MIN: intParam().default(125),
  // Numero massimo di profili per giocatore (POC: 1).
  MAX_PROFILES_PER_PLAYER: intParam().default(1),
  // Quota di iscrizione in EUR — placeholder Fase 1, non usato nella POC.
  ENTRY_FEE_EUR: z.coerce.number().nonnegative().default(5),
  // Percentuale (0-100) del montepremi al vincitore — placeholder Fase 1, non usato nella POC.
  WINNER_SHARE_PCT: z.coerce.number().min(0).max(100).default(85),

  // --- §4.2 Parametri infrastruttura ---
  // Fuso orario di sistema (stringa IANA) per la comunicazione verso
  // l'esterno (ADR-011): date nelle email + timestamp dei log pino. Il
  // sistema di gioco lavora SEMPRE su istanti UTC assoluti: il fuso conta
  // solo quando si mostra una data. Valori: qualunque timezone IANA
  // (es. Europe/Rome, America/New_York); una stringa non valida fa fallire
  // l'avvio con un errore che nomina la variabile. Cambiarlo non altera le
  // decisioni di gioco: sposta solo le date mostrate verso l'esterno.
  TIMEZONE: timezoneParam(),
  // Directory di destinazione degli export AUTOMATICI del torneo
  // (ADR-011, chiusura automatica): quando il torneo si chiude il sistema
  // scrive qui il dump JSON completo (riuso di tournamentExport, filename
  // con timestamp dal clock iniettato). La directory è creata se assente;
  // l'export è l'archivio che rende sicuro il reset del DB di gioco al
  // riavvio. Valore: percorso relativo o assoluto scrivibile dal processo.
  TOURNAMENT_EXPORT_DIR: z.string().min(1).default('./data/exports/'),
  IMAP_HOST: z.string().default('imap.gmail.com'),
  IMAP_PORT: intParam().default(993),
  IMAP_USER: required(),
  IMAP_PASS: required(), // App Password Gmail
  SMTP_HOST: z.string().default('smtp.gmail.com'),
  SMTP_PORT: intParam().default(587),
  SMTP_USER: required(),
  SMTP_PASS: required(), // App Password Gmail
  // Chiave API del provider LLM. OPZIONALE (default vuota) quando sia
  // `AI_EMAIL_GENERATOR` sia `AI_EMAIL_PARSER` sono false (run senza IA):
  // la superRefine qui sotto la rende OBBLIGATORIA se almeno un flag è true.
  LLM_API_KEY: z.string().default(''),
  LLM_API_BASE_URL: z.url().default('https://api.openai.com/v1'),
  // Lista dei modelli LLM separata da virgola, in ordine di PRIORITÀ (il
  // primo è il primario): il client prova il primo e, esauriti i retry, passa
  // al successivo (failover, D1). Ogni voce è trim, le voci vuote sono
  // scartate e i duplicati eliminati mantenendo l'ordine; una lista vuota
  // (es. LLM_MODEL= o ,,) è un ConfigError che nomina la variabile.
  LLM_MODEL: z
    .string()
    .min(1, 'variabile richiesta vuota o mancante')
    .default('gpt-4o-mini')
    .transform((value) => {
      const seen = new Set<string>();
      return value.split(',').reduce<string[]>((models, item) => {
        const trimmed = item.trim();
        if (trimmed !== '' && !seen.has(trimmed)) {
          seen.add(trimmed);
          models.push(trimmed);
        }
        return models;
      }, []);
    })
    .refine((models) => models.length > 0, 'lista vuota: serve almeno un modello'),
  // Timeout di una singola richiesta LLM in millisecondi: abbassarlo rende
  // il failover più rapido ma scarta risposte legittime lente (tier free);
  // alzarlo copre più latenza ma peggiora il worst case (modelli × retry × timeout).
  LLM_TIMEOUT_MS: intParam().default(15000),
  // Tentativi TOTALI per modello LLM (1 richiesta + N-1 ritentativi su errore
  // trasporto/HTTP ritentabile: 429, 5xx, timeout, rete, body malformato);
  // 1 = nessun ritentativo. I 4xx deterministici non vengono ritentati.
  LLM_RETRIES: intParam().default(3),
  // Interruttore generazione IA delle email (email v3): true = narrativa LLM
  // con fallback deterministico su LLMError/narrativa degenerata; assente o
  // false = generatore deterministico (mai chiamate LLM per i testi email).
  // La variabile è letta a OGNI invocazione CLI via getConfig()/zod: cambiare
  // .env ha effetto dal comando/tick successivo, nessun daemon da riavviare.
  // NON tocca Parser/Classificatore (lato input), che restano sempre LLM.
  AI_EMAIL_GENERATOR: boolParam('false'),
  // Interruttore classificazione deterministica dell'INPUT email (email v3,
  // Parte B): true = classificazione LLM con fallback per-messaggio sul parser
  // deterministico; assente o false = parser deterministico (formule univoche
  // `ISCRIZIONE [NOME]`/`DISISCRIZIONE`/`<TEAM> <ESITO>` nel subject o corpo),
  // MAI chiamate LLM per la classificazione. Con entrambi i flag AI false la
  // `LLM_API_KEY` non è più richiesta (run senza IA).
  AI_EMAIL_PARSER: boolParam('false'),
  // Percorso del file SQLite; la directory viene creata da db/connection.ts se assente.
  DB_PATH: z.string().min(1).default('./data/survivor.db'),
  // Percorso del DB PIATTAFORMA (ADR-009, RF-P7): storage SEPARATO degli
  // account (registerID/email/status). MAI uguale a DB_PATH: due connessioni
  // distinte, nessuna transazione cross-DB. `platform:migrate` lo migra;
  // `channel:email:process`/`simulate:*` lo richiedono (errore esplicito se
  // assente); `simulate:*` rifiuta/avvisa se coincide col valore di produzione.
  // Default = PLATFORM_DB_PATH_DEFAULT (costante sopra, unica fonte del
  // valore di produzione, usata anche dalla guardia di simulazione).
  PLATFORM_DB_PATH: z.string().min(1).default(PLATFORM_DB_PATH_DEFAULT),
  // Livello di log pino: debug | info | warn | error.
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // Intervallo (millisecondi) tra due letture della casella IMAP.
  IMAP_POLL_MS: intParam().default(60000),

  // --- §4.3 Parametri dati stagione ---
  FOOTBALL_DATA_TOKEN: required(), // header X-Auth-Token; fornito dal PO
  FOOTBALL_DATA_BASE_URL: z.url().default('https://api.football-data.org'),
  FOOTBALL_DATA_COMPETITION: z.string().default('SA'), // SA = Serie A
  FOOTBALL_DATA_SEASON: intParam().default(2025), // anno di inizio stagione (2025 = 2025/26)

  // --- §4.4 Parametri scheduler ---
  // true = cron attivo (produzione); false = solo comandi CLI manuali (sviluppo/test).
  SCHEDULER_ENABLED: boolParam('false'),
  // Intervallo (minuti) tra due esecuzioni di scheduler:tick da cron.
  SCHEDULER_TICK_MIN: intParam().default(1),
  // true = lo scheduler invoca round:score per i round chiusi pendenti.
  SCHEDULER_AUTO_SCORE: boolParam('true'),

  // --- Simulazione (decisione 11 del piano; usata solo dai comandi simulate:*) ---
  // Numero di profili sintetici registrati dalla simulazione full-season.
  SIM_PLAYERS: intParam().default(10),

  // --- Test mode (§0.1/D9 del piano UAT) ---
  // Attiva la modalità test: banner email/CLI/log, risorsa alias sintetica e
  // gating a consumo dei parametri test-only (TEST_OFFSET_DAYS, TEST_REFRESH_ALLOWED).
  // Caricato dal file env di test (es. .env.uat) quando ENV_FILE=.env.uat;
  // MAI impostare nei file di produzione.
  TEST_MODE: boolParam('false'),
  // Offset orario unificato in giorni (test-only): quando > 0 e testMode attivo
  // sposta sia il clock (makeNow) sia il receivedAt delle email dello stesso
  // delta, per il replay di dati storici (es. stagione 2025). Default 0 =
  // disattivato. Parser tollerante: malformato → 0 senza errore.
  TEST_OFFSET_DAYS: testOffsetDaysParam(),
  // Consenti refresh/import da API anche in test mode (test-only). Default false =
  // bloccati in TEST_MODE; true = abilitati con log WARN di consenso a ogni
  // operazione (incluso DB_PATH). Usabile SOLO su DB con dati reali, MAI su
  // calendario sintetico. Parser tollerante: malformato → false senza errore.
  TEST_REFRESH_ALLOWED: testRefreshAllowedParam()
}).superRefine((data, ctx) => {
  // email v3 Parte B: `LLM_API_KEY` è obbligatoria SOLO se almeno un flag IA è
  // attivo; con entrambi false il sistema è interamente deterministico e la
  // chiave non serve (run senza IA). L'errore nomina `LLM_API_KEY`.
  if ((data.AI_EMAIL_GENERATOR || data.AI_EMAIL_PARSER) && data.LLM_API_KEY.trim() === '') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['LLM_API_KEY'],
      message: 'variabile richiesta quando AI_EMAIL_GENERATOR o AI_EMAIL_PARSER è true'
    });
  }
});

/** Tipo grezzo parsato da zod (solo campi dell'env — testMode è derivato). */
type ParsedConfig = z.infer<typeof configSchema>;

/**
 * Configurazione validata: tipi già convertiti (numeri, booleani) e default
 * applicati. Include il campo derivato `testMode` (comodità per i consumer:
 * equivalente a `TEST_MODE` ma con nome coerente) oltre ai campi grezzi
 * `TEST_MODE`, `TEST_OFFSET_DAYS`, `TEST_REFRESH_ALLOWED`.
 */
export type AppConfig = ParsedConfig & { testMode: boolean };

/** Errore di configurazione all'avvio: il messaggio elenca le variabili mancanti/invalid. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Valida un record di variabili d'ambiente e restituisce la configurazione tipizzata.
 * Funzione pura (nessun accesso a process.env né al filesystem): è il punto
 * testabile della configurazione. Lancia ConfigError nominando ogni variabile
 * mancante o con formato errato (LLD §4.5).
 */
export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const name = issue.path.join('.');
        // Variabile assente (undefined): messaggio esplicito invece del dettaglio zod sul tipo.
        const detail =
          issue.code === 'invalid_type' && issue.input === undefined
            ? 'variabile richiesta mancante'
            : issue.message;
        return `  - ${name}: ${detail}`;
      })
      .join('\n');
    throw new ConfigError(
      `Configurazione non valida. Variabili mancanti o con formato errato:\n${details}`
    );
  }
  return { ...result.data, testMode: result.data.TEST_MODE };
}

let cached: AppConfig | undefined;

/**
 * Decide il path del file env e lo carica con process.loadEnvFile nativo di
 * Node ≥20.12 (LLD §4.5, piano UAT §0.2). Errori:
 * - `ENV_FILE` esplicito ma path inesistente → ConfigError che nomina il path;
 * - `.env` (default) assente → silenzioso (variabili dall'ambiente del cron);
 * - qualsiasi altro errore (es. permessi) → rilanciato.
 * La semantica no-override di loadEnvFile è documentata in LLD §4.5.
 */
export function loadEnvFile(): void {
  const envFile = process.env.ENV_FILE ?? '.env';
  try {
    process.loadEnvFile(envFile);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENV_FILE esplicito ma file non trovato: errore esplicito con il path.
    if (code === 'ENOENT' && process.env.ENV_FILE !== undefined) {
      throw new ConfigError(
        `File env non trovato: ${envFile} (specificato da ENV_FILE). Verifica il percorso.`
      );
    }
    // .env assente (default): non è un errore, le variabili possono arrivare dall'ambiente.
    if (code !== 'ENOENT') throw error;
  }
}

/**
 * Restituisce la configurazione dell'applicazione, calcolandola al primo uso:
 * carica il file env (se presente) e valida process.env. Il caricamento è
 * lazy volutamente: comandi che non richiedono configurazione (es. --help)
 * devono funzionare anche senza file env; qualsiasi comando che accede alla
 * configurazione fallisce all'avvio con ConfigError esplicito (LLD §4.5).
 */
export function getConfig(): AppConfig {
  if (cached === undefined) {
    loadEnvFile();
    cached = parseConfig(process.env);
  }
  return cached;
}
