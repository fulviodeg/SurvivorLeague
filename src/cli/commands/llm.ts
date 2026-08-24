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
 *     "Round N · Turno di campionato M", ADR-011) + corpo RENDERIZZATO
 *     (header/box/CTA deterministici attorno alla narrativa LLM).
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
import { OpenAIIntentClassifier } from '../../llm/intent-classifier.js';
import { OpenAIClient } from '../../llm/openai-client.js';
import { loadTeamAliasesFor, OpenAIParser } from '../../llm/parser.js';
import { jsonWithTestMode, printTestModeBanner } from '../output.js';

interface JsonArg {
  json: boolean;
}

export const llmParseCommand: CommandModule<object, JsonArg & { input: string }> = {
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
      }),
  handler: async (argv) => {
    const config = getConfig();
    const db = createConnection(config.DB_PATH);
    try {
      migrate(db);
      const provider = new DbSeasonDataProvider(db);
      const teams = await provider.getTeams();
      const aliases = await loadTeamAliasesFor(config.testMode);
      const parser = new OpenAIParser(
        new OpenAIClient({
          baseUrl: config.LLM_API_BASE_URL,
          apiKey: config.LLM_API_KEY,
          models: config.LLM_MODEL,
          timeoutMs: config.LLM_TIMEOUT_MS,
          retries: config.LLM_RETRIES
        })
      );
      const result = await parser.extractPick(argv.input, { teams, aliases, testMode: config.testMode });
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
        console.log(`{team: "${result.team}", outcome: "${result.outcome}"}`);
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
}

export const llmClassifyCommand: CommandModule<object, ClassifyArgs> = {
  command: 'llm:classify',
  describe:
    'Classifica {intent, pick} dal corpo del messaggio in UNA chiamata LLM (ADR-009); input JSON {"body": "..."} o testo libero',
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
      }),
  handler: async (argv) => {
    const config = getConfig();
    const db = createConnection(config.DB_PATH);
    try {
      migrate(db);
      const provider = new DbSeasonDataProvider(db);
      const teams = await provider.getTeams();
      const aliases = await loadTeamAliasesFor(config.testMode);
      const classifier = new OpenAIIntentClassifier(
        new OpenAIClient({
          baseUrl: config.LLM_API_BASE_URL,
          apiKey: config.LLM_API_KEY,
          models: config.LLM_MODEL,
          timeoutMs: config.LLM_TIMEOUT_MS,
          retries: config.LLM_RETRIES
        })
      );
      const body = classifyInputBody(argv.input);
      const result = await classifier.classify(body, { teams, aliases, testMode: config.testMode });
      if (argv.json) {
        console.log(jsonWithTestMode(config, result));
      } else {
        printTestModeBanner(config);
        if (result.intent === 'pick' && result.pick !== null) {
          console.log(
            `{intent: "pick", pick: {team: "${result.pick.team}", outcome: "${result.pick.outcome}"}}`
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
        describe: 'Esito del pick'
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
      availableTeams: argv.availableTeams?.split(',').map((t) => t.trim()).filter((t) => t !== '')
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
          config.TIMEZONE
        )
      : new DeterministicGenerator(config.TIMEZONE);
    const body = await generator.generate(emailCtx);
    const subject = subjectFor(emailCtx);
    if (argv.json) {
      console.log(jsonWithTestMode(config, { subject, body }));
    } else {
      printTestModeBanner(config);
      console.log(`Oggetto: ${subject}\n\n${body}`);
    }
  }
};
