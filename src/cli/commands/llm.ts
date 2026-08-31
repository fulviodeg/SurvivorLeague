/**
 * Comandi CLI del LLM Adapter (LLD §7.8, piano Task 5.1/5.2/6).
 *
 * Ruolo:
 *   - `llm:parse --input <text>` — estrae {team, outcome} dal testo libero:
 *     lista canonica da `getTeams()` (DB reale, DbSeasonDataProvider) +
 *     contenuto di `team-aliases.md` iniettati per chiamata (D2); DB vuoto →
 *     lista vuota → {team: null} con messaggio chiaro;
 *   - `llm:classify --input <json>` — classifica {intent, pick} dal corpo del
 *     messaggio in UNA chiamata LLM (ADR-009, RF-P1/P2): l'input JSON può
 *     contenere il campo `body` (testo del messaggio) o essere direttamente il
 *     testo; output JSON `{intent, pick}` (piano Task 6; ogni componente
 *     espone un comando verificabile in modo indipendente, ADR-006);
 *   - `llm:generate --type <t> [--player-name] [--tt] [--tc] [--team]
 *     [--outcome] [--reason] [--deadline] [--available-teams]` — genera
 *     l'email dal contesto: output = SOGGETTO (subjectFor, forma UMANA
 *     "Turno {TC} di Campionato - {etichetta}", ADR-013) + corpo RENDERIZZATO
 *     (header "Round del torneo N · Turno di Campionato M"/box/CTA
 *     deterministici attorno alla narrativa).
 *
 * Pattern CLI consolidato: il comando costruisce config → DB → provider e
 * inietta i parametri; i moduli LLM non accedono mai a DB/config (ADR-004).
 */
import type { Argv, CommandModule } from 'yargs';

import { getConfig } from '../../config.js';
import { DbSeasonDataProvider } from '../../data/db-provider.js';
import { createConnection } from '../../db/connection.js';
import { migrate } from '../../db/schema.js';
import { EMAIL_TYPES, OpenAIGenerator, subjectFor, type EmailContext } from '../../llm/generator.js';
import { DeterministicGenerator } from '../../llm/deterministic-generator.js';
import {
  DeterministicIntentClassifier,
  FallbackIntentClassifier
} from '../../llm/deterministic-parser.js';
import { OpenAIIntentClassifier } from '../../llm/intent-classifier.js';
import { OpenAIClient } from '../../llm/openai-client.js';
import { loadTeamAliasesFor } from '../../llm/parser.js';
import { createLogger } from '../../logger.js';
import { modeFor } from '../../game/mode.js';
import { jsonWithTestMode, printTestModeBanner } from '../output.js';

interface JsonArg {
  json: boolean;
}

export const llmParseCommand: CommandModule<object, JsonArg & { input: string; mode?: string }> = {
  command: 'llm:parse',
  describe:
    'Estrae {team, outcome} da testo libero (lista canonica da DB + team-aliases.md iniettati per chiamata, D2)',
  builder: (yargs: Argv<object>) =>
    yargs
      .option('json', {
        type: 'boolean' as const,
        default: false,
        describe: 'Output JSON strutturato invece di testo (LLD §7.13)'
      })
      .option('input', {
        type: 'string' as const,
        demandOption: true,
        describe: 'Testo dell\'email del giocatore da analizzare'
      })
      .option('mode', {
        type: 'string' as const,
        choices: ['llm', 'deterministic'],
        describe:
          'Modalità di estrazione: llm (LLM) o deterministic (formule univoche); default = AI_EMAIL_PARSER della config'
      }),
  handler: async (argv) => {
    const config = getConfig();
    const db = createConnection(config.DB_PATH);
    try {
      migrate(db);
      const provider = new DbSeasonDataProvider(db);
      const teams = await provider.getTeams();
      const aliases = await loadTeamAliasesFor(config.testMode);
      // Feature JOLLY: riconoscere la keyword "jolly" solo quando attiva.
      const opts = {
        teams,
        aliases,
        testMode: config.testMode,
        winOnly: config.WIN_ONLY,
        jollyEnabled: config.WIN_ONLY && config.JOLLIES_PER_PLAYER >= 1
      };
      // `--mode` esplicito prevale sulla config; senza --mode si segue la config
      // (default deterministico, email v3 Parte B). In modalità LLM il
      // classificatore è avvolto dal `FallbackIntentClassifier` (come il
      // wiring email, AI_EMAIL_PARSER=true): su LLMError e sugli esiti
      // dubbiosi (other/pick:null) il deterministico decide — la diagnostica
      // CLI replica il comportamento reale del canale (bug UAT 2026-08-30).
      const useLlm = argv.mode === 'llm' || (argv.mode === undefined && config.AI_EMAIL_PARSER);
      const logger = createLogger(
        config.LOG_LEVEL,
        undefined,
        config.testMode,
        config.TIMEZONE,
        config.LOG_FILE
      );
      const client = new OpenAIClient({
        baseUrl: config.LLM_API_BASE_URL,
        apiKey: config.LLM_API_KEY,
        models: config.LLM_MODEL,
        timeoutMs: config.LLM_TIMEOUT_MS,
        retries: config.LLM_RETRIES
      });
      const result = useLlm
        ? (
            await new FallbackIntentClassifier(
              new OpenAIIntentClassifier(client),
              new DeterministicIntentClassifier(),
              logger
            ).classify(argv.input, opts)
          ).pick
        : (await new DeterministicIntentClassifier().classify(argv.input, opts)).pick;
      const output = result ?? { team: null };
      if (argv.json) {
        console.log(jsonWithTestMode(config, output));
      } else if (teams.length === 0) {
        printTestModeBanner(config);
        console.log('{team: null} — lista canonica vuota: importa i dati stagione (data:import)');
      } else if (result === null) {
        printTestModeBanner(config);
        console.log('{team: null} — pick non riconosciuto o ambiguo (CS7)');
      } else {
        printTestModeBanner(config);
        // Feature JOLLY: il flag jolly è mostrato quando presente.
        const jollyText = result.jolly === true ? ', jolly: true' : '';
        console.log(`{team: "${result.team}", outcome: "${result.outcome}"${jollyText}}`);
      }
    } finally {
      db.close();
    }
  }
};

/**
 * Estrae il corpo del messaggio dall'input del comando `llm:classify`
 * (ADR-009): se `input` è un JSON valido contenente il campo `body` usa quel
 * campo; altrimenti usa l'intera stringa come corpo (permette sia il JSON
 * strutturato sia il testo libero in copia-incolla).
 */
export function classifyInputBody(input: string): string {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { body?: unknown }).body === 'string'
    ) {
      return (parsed as { body: string }).body;
    }
  } catch {
    // Non-JSON: l'input è già il corpo del messaggio.
  }
  return input;
}

interface ClassifyArgs extends JsonArg {
  input: string;
  mode?: string;
}

export const llmClassifyCommand: CommandModule<object, ClassifyArgs> = {
  command: 'llm:classify',
  describe:
    'Classifica {intent, pick} dal corpo del messaggio (LLM, ADR-009, o deterministico con formule univoche); input JSON {"body": "..."} o testo libero',
  builder: (yargs: Argv<object>) =>
    yargs
      .option('json', {
        type: 'boolean' as const,
        default: false,
        describe: 'Output JSON strutturato invece di testo (LLD §7.13)'
      })
      .option('input', {
        type: 'string' as const,
        demandOption: true,
        describe: 'Testo del messaggio o JSON {"body": "<testo>"} da classificare'
      })
      .option('mode', {
        type: 'string' as const,
        choices: ['llm', 'deterministic'],
        describe:
          'Modalità di classificazione: llm (LLM) o deterministic (formule univoche); default = AI_EMAIL_PARSER della config'
      }),
  handler: async (argv) => {
    const config = getConfig();
    const db = createConnection(config.DB_PATH);
    try {
      migrate(db);
      const provider = new DbSeasonDataProvider(db);
      const teams = await provider.getTeams();
      const aliases = await loadTeamAliasesFor(config.testMode);
      // `--mode` esplicito prevale sulla config; senza --mode si segue la config
      // (default deterministico, email v3 Parte B). In modalità LLM il
      // classificatore è avvolto dal `FallbackIntentClassifier` (come il
      // wiring email, AI_EMAIL_PARSER=true): su LLMError e sugli esiti
      // dubbiosi (other/pick:null) il deterministico decide — la diagnostica
      // CLI replica il comportamento reale del canale (bug UAT 2026-08-30).
      const useLlm = argv.mode === 'llm' || (argv.mode === undefined && config.AI_EMAIL_PARSER);
      const logger = createLogger(
        config.LOG_LEVEL,
        undefined,
        config.testMode,
        config.TIMEZONE,
        config.LOG_FILE
      );
      const classifier = useLlm
        ? new FallbackIntentClassifier(
            new OpenAIIntentClassifier(
              new OpenAIClient({
                baseUrl: config.LLM_API_BASE_URL,
                apiKey: config.LLM_API_KEY,
                models: config.LLM_MODEL,
                timeoutMs: config.LLM_TIMEOUT_MS,
                retries: config.LLM_RETRIES
              })
            ),
            new DeterministicIntentClassifier(),
            logger
          )
        : new DeterministicIntentClassifier();
      const body = classifyInputBody(argv.input);
      const result = await classifier.classify(body, {
        teams,
        aliases,
        testMode: config.testMode,
        winOnly: config.WIN_ONLY,
        // Feature JOLLY: riconoscere la keyword "jolly" solo quando attiva.
        jollyEnabled: config.WIN_ONLY && config.JOLLIES_PER_PLAYER >= 1
      });
      if (argv.json) {
        console.log(jsonWithTestMode(config, result));
      } else {
        printTestModeBanner(config);
        if (result.intent === 'pick' && result.pick !== null) {
          // Feature JOLLY: il flag jolly è mostrato quando presente.
          const jollyText = result.pick.jolly === true ? ', jolly: true' : '';
          console.log(
            `{intent: "pick", pick: {team: "${result.pick.team}", outcome: "${result.pick.outcome}"${jollyText}}}`
          );
        } else {
          console.log(`{intent: "${result.intent}", pick: ${JSON.stringify(result.pick)}}`);
        }
      }
    } finally {
      db.close();
    }
  }
};

interface GenerateArgs extends JsonArg {
  type: string;
  playerName?: string;
  tt?: number;
  tc?: number;
  team?: string;
  outcome?: string;
  reason?: string;
  deadline?: string;
  availableTeams?: string;
  mode?: string;
  jollyUsed?: boolean;
  jolliesRemaining?: number;
}

export const llmGenerateCommand: CommandModule<object, GenerateArgs> = {
  command: 'llm:generate',
  describe:
    'Genera l\'email dal contesto strutturato (output: soggetto subjectFor in forma umana + corpo renderizzato, D1/ADR-011)',
  builder: (yargs: Argv<object>) =>
    yargs
      .option('json', {
        type: 'boolean' as const,
        default: false,
        describe: 'Output JSON strutturato invece di testo (LLD §7.13)'
      })
      .option('type', {
        type: 'string' as const,
        demandOption: true,
        choices: EMAIL_TYPES,
        describe: 'Tipo di email da generare'
      })
      .option('playerName', { type: 'string' as const, describe: 'Nome del giocatore' })
      .option('tt', { type: 'number' as const, describe: 'Round del torneo (iniettato, RF-25)' })
      .option('tc', { type: 'number' as const, describe: 'Turno di campionato (iniettato, RF-25)' })
      .option('team', { type: 'string' as const, describe: 'Squadra del pick (nome canonico)' })
      .option('outcome', {
        type: 'string' as const,
        choices: ['win', 'draw', 'lose'],
        describe: 'Esito del pick (in win_only è sempre win)'
      })
      .option('reason', { type: 'string' as const, describe: 'Motivo di rifiuto/eliminazione' })
      .option('deadline', {
        type: 'string' as const,
        describe: 'Scadenza in formato ISO-8601 (mostrata in it-IT nel TIMEZONE di sistema — ADR-011)'
      })
      .option('availableTeams', {
        type: 'string' as const,
        describe: 'Squadre disponibili separate da virgola'
      })
      .option('jollyUsed', {
        type: 'boolean' as const,
        default: false,
        describe:
          'Feature JOLLY (smoke manuale): il pick di questa mail è stato dichiarato con jolly'
      })
      .option('jolliesRemaining', {
        type: 'number' as const,
        describe:
          'Feature JOLLY (smoke manuale): jolly rimasti al destinatario (riga "Jolly rimasti: N")'
      })
      .option('mode', {
        type: 'string' as const,
        choices: ['llm', 'deterministic'],
        describe:
          'Modalità di generazione: llm (narrativa LLM) o deterministic (testi fissi); default = AI_EMAIL_GENERATOR della config'
      }),
  handler: async (argv) => {
    const config = getConfig();
    const emailCtx: EmailContext = {
      type: argv.type as EmailContext['type'],
      playerName: argv.playerName,
      round: argv.tt,
      championshipRound: argv.tc,
      team: argv.team,
      outcome: argv.outcome,
      reason: argv.reason,
      deadline: argv.deadline !== undefined ? new Date(argv.deadline) : undefined,
      availableTeams: argv.availableTeams?.split(',').map((t) => t.trim()).filter((t) => t !== ''),
      // Feature JOLLY (smoke manuale): flag runtime per esercitare il renderer.
      ...(argv.jollyUsed === true ? { jollyUsed: true } : {}),
      ...(argv.jolliesRemaining !== undefined ? { jolliesRemaining: argv.jolliesRemaining } : {})
    };
    // `--mode` esplicito prevale sulla config (confronto delle due strade sullo
    // stesso input senza toccare AI_EMAIL_GENERATOR); senza --mode si segue la
    // config (default deterministico, email v3).
    const useLlm = argv.mode === 'llm' || (argv.mode === undefined && config.AI_EMAIL_GENERATOR);
    const generator = useLlm
      ? new OpenAIGenerator(
          new OpenAIClient({
            baseUrl: config.LLM_API_BASE_URL,
            apiKey: config.LLM_API_KEY,
            models: config.LLM_MODEL,
            timeoutMs: config.LLM_TIMEOUT_MS,
            retries: config.LLM_RETRIES
          }),
          config.TIMEZONE,
          modeFor(config.WIN_ONLY, config.JOLLIES_PER_PLAYER)
        )
      : new DeterministicGenerator(config.TIMEZONE, modeFor(config.WIN_ONLY, config.JOLLIES_PER_PLAYER));
    const body = await generator.generate(emailCtx);
    const subject = subjectFor(emailCtx, config.testMode);
    if (argv.json) {
      console.log(jsonWithTestMode(config, { subject, body }));
    } else {
      printTestModeBanner(config);
      console.log(`Oggetto: ${subject}\n\n${body}`);
    }
  }
};
