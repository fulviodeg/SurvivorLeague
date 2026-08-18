/**
 * Comandi CLI del Pick Processor (LLD §7.4, piano Task 3.2).
 *
 * Ruolo: espone la validazione e la registrazione dei pick:
 *   - `pick:validate --round <n> --profileId <id> --team <name> --outcome <win|draw|lose>`
 *     — valida SENZA registrare; output JSON `{valid, reason}` (LLD §7.4);
 *   - `pick:register … [--reason <motivo>]` — valida SEMPRE (stesse regole dei
 *     pick automatici, decisione 9 del piano) e registra atomicamente; `--reason`
 *     è l'override US10 che bypassa SOLO i check temporali (RF-31/CL18); un pick
 *     rifiutato esce con codice 1 e il motivo nel messaggio;
 *   - `pick:list [--round <n>] [--profileId <id>]` — lista pick (sola lettura,
 *     idempotente); almeno un filtro è richiesto.
 *
 * Pattern CLI consolidato (briefing §1-I): il comando costruisce il contesto
 * `{ db, dataProvider, config, now }` con `now = new Date()` come receivedAt
 * (la CLI del commissioner riceve "adesso"; nei test il timestamp è forzato,
 * CS4) e lo passa al modulo — mai `getConfig()` dentro il Pick Processor.
 */
import type { Argv, CommandModule } from 'yargs';

import { getConfig } from '../../config.js';
import { DbSeasonDataProvider } from '../../data/db-provider.js';
import { createConnection } from '../../db/connection.js';
import { migrate } from '../../db/schema.js';
import type { GameContext } from '../../game/context.js';
import { listPicks, registerPick, validatePick } from '../../game/pick-processor.js';
import { makeNow } from '../../clock.js';
import { jsonWithTestMode, printTestModeBanner } from '../output.js';

/** Costruisce il contesto di gioco con receivedAt = adesso (clock della CLI, offset test-only). */
function makeGameContext(): { ctx: GameContext; db: ReturnType<typeof createConnection> } {
  const config = getConfig();
  const db = createConnection(config.DB_PATH);
  migrate(db);
  const dataProvider = new DbSeasonDataProvider(db);
  return { ctx: { db, dataProvider, config, now: makeNow(config) }, db };
}

/** Opzione JSON condivisa dai comandi (LLD §7.13). */
function jsonOption(y: Argv<object>) {
  return y.option('json', {
    type: 'boolean' as const,
    default: false,
    describe: 'Output JSON strutturato invece di testo (LLD §7.13)'
  });
}

interface JsonArg {
  json: boolean;
}
interface ValidateArgs extends JsonArg {
  round: number;
  profileId: number;
  team: string;
  outcome: string;
}
interface RegisterArgs extends ValidateArgs {
  reason?: string;
}
interface ListArgs extends JsonArg {
  round?: number;
  profileId?: number;
}

/**
 * Builder condiviso di validate/register: round, profilo, squadra, esito.
 * Inline (come gli altri comandi del repo) per preservare l'accumulo dei tipi
 * yargs — un helper separato con Argv<object> perderebbe i campi.
 */
const pickBuilder = (yargs: Argv<object>) =>
  jsonOption(yargs)
    .option('round', {
      type: 'number' as const,
      demandOption: true,
      describe: 'Numero del round (TC)'
    })
    .option('profileId', {
      type: 'number' as const,
      demandOption: true,
      describe: 'ID del profilo'
    })
    .option('team', {
      type: 'string' as const,
      demandOption: true,
      describe: 'Nome canonico della squadra (exact-match)'
    })
    .option('outcome', {
      type: 'string' as const,
      demandOption: true,
      // Nessun vincolo qui: la validazione dell'esito (invalid_outcome) è nella
      // cascata del Pick Processor, così il CLI espone tutti i motivi (US2).
      describe: 'Esito previsto: win | draw | lose'
    });

export const pickValidateCommand: CommandModule<object, ValidateArgs> = {
  command: 'pick:validate',
  describe: 'Valida un pick senza registrarlo; output JSON {valid, reason} (LLD §7.4)',
  builder: pickBuilder,
  handler: async (argv) => {
    const { ctx, db } = makeGameContext();
    try {
      const result = await validatePick(ctx, {
        profileId: argv.profileId,
        round: argv.round,
        team: argv.team,
        outcome: argv.outcome,
        receivedAt: ctx.now
      });
      if (argv.json) {
        console.log(jsonWithTestMode(ctx.config, result));
      } else {
        printTestModeBanner(ctx.config);
        console.log(
          result.valid
            ? 'Pick valido'
            : `Pick non valido: ${result.reason}`
        );
      }
    } finally {
      db.close();
    }
  }
};

export const pickRegisterCommand: CommandModule<object, RegisterArgs> = {
  command: 'pick:register',
  describe:
    'Registra un pick dopo averlo validato (stesse regole dei pick automatici); --reason = override US10 fuori accettazione',
  builder: (yargs) =>
    pickBuilder(yargs).option('reason', {
      type: 'string' as const,
      describe:
        "Motivo auditato dell'override del commissioner (obbligatorio fuori accettazione, US10/ADR-008)"
    }),
  handler: async (argv) => {
    const { ctx, db } = makeGameContext();
    try {
      const result = await registerPick(
        ctx,
        {
          profileId: argv.profileId,
          round: argv.round,
          team: argv.team,
          outcome: argv.outcome,
          receivedAt: ctx.now
        },
        { reason: argv.reason }
      );
      if (!result.ok) {
        // Rifiuto: messaggio pulito con il motivo + exit 1 (pattern .fail della CLI).
        throw new Error(`Pick rifiutato: ${result.reason}`);
      }
      if (argv.json) {
        console.log(jsonWithTestMode(ctx.config, { id: result.id, status: result.status }));
      } else {
        printTestModeBanner(ctx.config);
        console.log(`Pick registrato: id ${result.id} (${result.status})`);
      }
    } finally {
      db.close();
    }
  }
};

export const pickListCommand: CommandModule<object, ListArgs> = {
  command: 'pick:list',
  describe: 'Lista pick registrati (sola lettura), filtrati per round e/o profilo',
  builder: (yargs) =>
    jsonOption(yargs)
      .option('round', { type: 'number' as const, describe: 'Filtra per round (TC)' })
      .option('profileId', { type: 'number' as const, describe: 'Filtra per profilo' })
      .check((argv) => {
        if (argv.round === undefined && argv.profileId === undefined) {
          throw new Error('Specifica almeno un filtro: --round e/o --profileId');
        }
        return true;
      }),
  handler: (argv) => {
    const { ctx, db } = makeGameContext();
    try {
      const picks = listPicks(ctx.db, { round: argv.round, profileId: argv.profileId });
      if (argv.json) {
        console.log(jsonWithTestMode(ctx.config, picks));
      } else if (picks.length === 0) {
        printTestModeBanner(ctx.config);
        console.log('Nessun pick trovato');
      } else {
        printTestModeBanner(ctx.config);
        for (const p of picks) {
          console.log(
            `#${p.id} profilo ${p.profileId} (${p.email}) R${p.round} ${p.team} ${p.outcome} [${p.status}]`
          );
        }
      }
    } finally {
      db.close();
    }
  }
};
