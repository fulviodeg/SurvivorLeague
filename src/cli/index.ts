import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import {
  dataCalendarCommand,
  dataImportCommand,
  dataRefreshCommand,
  dataResultsCommand,
  dataSeedSyntheticCommand
} from './commands/data.js';
import { dbMigrateCommand } from './commands/db.js';
import { eliminationCheckCommand, eliminationListCommand } from './commands/elimination.js';
import { pickListCommand, pickRegisterCommand, pickValidateCommand } from './commands/pick.js';
import {
  roundCloseCommand,
  roundDeadlineCommand,
  roundOpenCommand,
  roundScoreCommand,
  roundStatusCommand
} from './commands/round.js';
import {
  tournamentExportCommand,
  tournamentHistoryCommand,
  tournamentLeaderboardCommand,
  tournamentRegisterCloseCommand,
  tournamentRegisterCommand,
  tournamentRegisterOpenCommand,
  tournamentStartCommand,
  tournamentStatusCommand
} from './commands/tournament.js';
import {
  rulesAvailableCommand,
  rulesBurnedCommand,
  rulesCheckHalfCommand
} from './commands/rules.js';
import { winnerCheckCommand } from './commands/winner.js';
import { llmGenerateCommand, llmParseCommand } from './commands/llm.js';
import {
  channelEmailFetchCommand,
  channelEmailProcessCommand,
  channelEmailSendCommand
} from './commands/channel.js';
import { simulateFullCommand, simulateRoundCommand } from './commands/simulate.js';
import { schedulerStatusCommand, schedulerTickCommand } from './commands/scheduler.js';

/**
 * Registrazione dei comandi CLI (LLD §7).
 * Registrati: setup e dati stagione (db:migrate, data:*), Game Engine
 * (rules:*, pick:*, elimination:*, winner:*, round:*, tournament:*), LLM
 * Adapter (llm:parse, llm:generate — Fase 5), Channel Adapter
 * (channel:email:fetch/process/send — Fase 6), Simulazione (simulate:full,
 * simulate:round) e Scheduler (scheduler:tick, scheduler:status — Fase 7).
 * Ogni comando vive in src/cli/commands/ e segue il pattern consolidato
 * "la CLI inietta".
 */
export function createCli(argv: string[] = hideBin(process.argv)) {
  return yargs(argv)
    .scriptName('survivor')
    .usage('Survivor League — CLI di amministrazione della POC')
    .command(dbMigrateCommand)
    .command(dataImportCommand)
    .command(dataRefreshCommand)
    .command(dataCalendarCommand)
    .command(dataResultsCommand)
    .command(dataSeedSyntheticCommand)
    .command(rulesBurnedCommand)
    .command(rulesAvailableCommand)
    .command(rulesCheckHalfCommand)
    .command(pickValidateCommand)
    .command(pickRegisterCommand)
    .command(pickListCommand)
    .command(eliminationCheckCommand)
    .command(eliminationListCommand)
    .command(winnerCheckCommand)
    .command(roundOpenCommand)
    .command(roundCloseCommand)
    .command(roundScoreCommand)
    .command(roundStatusCommand)
    .command(roundDeadlineCommand)
    .command(tournamentStartCommand)
    .command(tournamentStatusCommand)
    .command(tournamentHistoryCommand)
    .command(tournamentLeaderboardCommand)
    .command(tournamentExportCommand)
    .command(tournamentRegisterOpenCommand)
    .command(tournamentRegisterCloseCommand)
    .command(tournamentRegisterCommand)
    .command(llmParseCommand)
    .command(llmGenerateCommand)
    .command(channelEmailFetchCommand)
    .command(channelEmailProcessCommand)
    .command(channelEmailSendCommand)
    .command(simulateFullCommand)
    .command(simulateRoundCommand)
    .command(schedulerTickCommand)
    .command(schedulerStatusCommand)
    .strict()
    .help()
    .alias('h', 'help')
    .version(false)
    .fail((msg, err) => {
      // Errori di comando e di handler (es. data:import fuori rete): print CLEAN
      // del messaggio, senza stack trace — contratto dei comandi (LLD §7.13).
      // yargs stampa di default l'intero oggetto errore per i rifiuti ASYNC dei
      // handler: qui lo si riduce al solo messaggio e si esce con codice 1.
      console.error(err instanceof Error ? err.message : (msg ?? String(err)));
      process.exit(1);
    });
}
