/**
 * Generatore deterministico delle email (email v3, piano email-v3 Task 4).
 *
 * Ruolo: implementazione `LLMGenerator` che produce il corpo email SENZA
 * chiamate di rete, usando la narrativa deterministica per tipo
 * (`DETERMINISTIC_NARRATIVES`, src/llm/templates.ts) e il renderer di canale
 * `renderEmailV2`. È la fonte di verità dell'output email: in modalità
 * `deterministic` (`AI_EMAIL_GENERATOR=false`, default) è l'implementazione
 * selezionata dal wiring; in modalità `llm` è il fallback su `LLMError`
 * (vedi `FallbackGenerator`).
 *
 * `FallbackGenerator` avvolge un generatore LLM: su `LLMError` (trasporto/
 * HTTP/timeout) ripiega sul corpo deterministico e logga un warn pino
 * `{reason, type}` — il giocatore riceve comunque l'email, il batch non si
 * ferma. La narrativa degenerata è già gestita dalla guardia
 * `deterministicNarrative` dentro `OpenAIGenerator` (nessun log qui).
 */
import { LLMError } from './errors.js';
import { renderEmailV2 } from './email-renderer.js';
import { DETERMINISTIC_NARRATIVES } from './templates.js';
import type { EmailContext, LLMGenerator } from './generator.js';

/** Logger minimale per il fallback (warn pino con oggetto + messaggio). */
export interface WarnLogger {
  warn: (obj: object, msg: string) => void;
}

/**
 * Generatore deterministico: compone il corpo con la narrativa FISSA per tipo
 * (`DETERMINISTIC_NARRATIVES[ctx.type]`) e il renderer di canale. ZERO
 * chiamate di rete: nessun client LLM iniettato.
 */
export class DeterministicGenerator implements LLMGenerator {
  private readonly timeZone: string;

  constructor(timeZone = 'Europe/Rome') {
    this.timeZone = timeZone;
  }

  async generate(ctx: EmailContext): Promise<string> {
    return renderEmailV2(ctx, DETERMINISTIC_NARRATIVES[ctx.type], this.timeZone);
  }
}

/**
 * Generatore con fallback deterministico (modalità `llm`): avvolge un
 * generatore LLM; su `LLMError` ripiega sul generatore deterministico e logga
 * un warn pino `{reason: 'llm_error', type}` — il giocatore riceve comunque
 * l'email deterministica e il batch non si ferma. Gli errori NON-LLM sono
 * rilanciati al chiamante.
 */
export class FallbackGenerator implements LLMGenerator {
  private readonly llm: LLMGenerator;
  private readonly deterministic: LLMGenerator;
  private readonly logger: WarnLogger;

  constructor(llm: LLMGenerator, deterministic: LLMGenerator, logger: WarnLogger) {
    this.llm = llm;
    this.deterministic = deterministic;
    this.logger = logger;
  }

  async generate(ctx: EmailContext): Promise<string> {
    try {
      return await this.llm.generate(ctx);
    } catch (error) {
      if (error instanceof LLMError) {
        this.logger.warn(
          { reason: 'llm_error', type: ctx.type },
          'LLM email generation failed — falling back to deterministic narrative'
        );
        return await this.deterministic.generate(ctx);
      }
      throw error;
    }
  }
}
