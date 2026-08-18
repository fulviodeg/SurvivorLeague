/**
 * Comandi CLI del LLM Adapter (LLD §7.8, piano Task 5.1/5.2).
 *
 * Ruolo:
 *   - `llm:parse --input <text>` — estrae {team, outcome} dal testo libero:
 *     lista canonica da `getTeams()` (DB reale, DbSeasonDataProvider) +
 *     contenuto di `team-aliases.md` iniettati per chiamata (D2); DB vuoto →
 *     lista vuota → {team: null} con messaggio chiaro;
 *   - `llm:generate --type <t> [--player-name] [--tt] [--tc] [--team]
 *     [--outcome] [--reason] [--deadline]` — genera l'email dal contesto:
 *     output = SOGGETTO (subjectFor, forma compatta TT2TC7, D1) + corpo
 *     (segnaposto {{TT_TC}} sostituito deterministicamente, D4); coppia
 *     assente → segnaposto sostituito con stringa vuota.
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
}

export const llmGenerateCommand: CommandModule<object, GenerateArgs> = {
  command: 'llm:generate',
  describe:
    'Genera l\'email dal contesto strutturato (output: soggetto subjectFor + corpo; coppia TT/TC iniettata deterministicamente, D1/D4)',
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
        describe: 'Tipo di email da generare (LLD §6.3)'
      })
      .option('playerName', { type: 'string' as const, describe: 'Nome del giocatore' })
      .option('tt', { type: 'number' as const, describe: 'Turno di torneo (iniettato, RF-25)' })
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
        describe: 'Scadenza in formato ISO-8601 (mostrata in it-IT, Europe/Rome — D9)'
      })
      .option('availableTeams', {
        type: 'string' as const,
        describe: 'Squadre disponibili separate da virgola'
      }),
  handler: async (argv) => {
    const config = getConfig();
    const emailCtx: EmailContext = {
      type: argv.type as EmailContext['type'],
      playerName: argv.playerName,
      tt: argv.tt,
      tc: argv.tc,
      team: argv.team,
      outcome: argv.outcome,
      reason: argv.reason,
      deadline: argv.deadline !== undefined ? new Date(argv.deadline) : undefined,
      availableTeams: argv.availableTeams?.split(',').map((t) => t.trim()).filter((t) => t !== '')
    };
    const generator = new OpenAIGenerator(
      new OpenAIClient({
        baseUrl: config.LLM_API_BASE_URL,
        apiKey: config.LLM_API_KEY,
        models: config.LLM_MODEL,
        timeoutMs: config.LLM_TIMEOUT_MS,
        retries: config.LLM_RETRIES
      })
    );
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
