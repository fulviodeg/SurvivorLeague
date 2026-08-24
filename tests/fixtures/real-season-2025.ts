/**
 * Fixture della STAGIONE REALE Serie A 2025/26 (football-data.org, SA 2025).
 *
 * Ruolo: dati REALI (non sintetici) per verificare che la guardia
 * anti-degenerazione della narrativa (`deterministicNarrative`, MAX_NARRATIVE_CHARS)
 * e il cap `TEXT_MAX_TOKENS` del client LLM reggano il contesto di una giornata
 * vera di campionato (10 partite, nomi ufficiali, punteggi reali). Le partite
 * del round 1 qui sotto sono estratte dal DB reale popolato da `data:import`
 * (data/survivor.db, 380 match, 38 round); l'ordine è quello del calendario.
 *
 * `LONG_LEGITIMATE_NARRATIVE` è una narrativa LEGITTIMA al limite superiore
 * realistico (4 frasi, ~600 caratteri, ~200 token stimati): documenta perché
 * i limiti non possono essere troppo bassi (con 600 caratteri produrrebbe un
 * falso positivo → fallback su testo valido). `estimateTokens` è un'euristica
 * prudenziale (parole×1.5 e caratteri/3, prende il massimo) per confrontare
 * la narrativa con `TEXT_MAX_TOKENS` senza dipendere dal tokenizer del provider.
 */
import type { EmailMatchContext } from '../../src/llm/generator.js';

/** Le 10 partite REALI del round 1 (giornata 23-25 agosto 2025, tutte giocate). */
export const REAL_SEASON_2025_ROUND_1: EmailMatchContext[] = [
  { home: 'Genoa CFC', away: 'US Lecce', score: { home: 0, away: 0 } },
  { home: 'US Sassuolo Calcio', away: 'SSC Napoli', score: { home: 0, away: 2 } },
  { home: 'AC Milan', away: 'US Cremonese', score: { home: 1, away: 2 } },
  { home: 'AS Roma', away: 'Bologna FC 1909', score: { home: 1, away: 0 } },
  { home: 'Cagliari Calcio', away: 'ACF Fiorentina', score: { home: 1, away: 1 } },
  { home: 'Como 1907', away: 'SS Lazio', score: { home: 2, away: 0 } },
  { home: 'Atalanta BC', away: 'AC Pisa 1909', score: { home: 1, away: 1 } },
  { home: 'Juventus FC', away: 'Parma Calcio 1913', score: { home: 2, away: 0 } },
  { home: 'Udinese Calcio', away: 'Hellas Verona FC', score: { home: 1, away: 1 } },
  { home: 'FC Internazionale Milano', away: 'Torino FC', score: { home: 5, away: 0 } }
];

/**
 * Narrativa legittima al limite realistico superiore: 4 frasi (non brevi),
 * entusiaste, riferite a un round vero con 10 partite. A ~600 caratteri e
 * ~200 token stimati è il caso che un limite a 600 caratteri scambierebbe per
 * output degenerato (falso positivo): i test la usano per fissare il margine.
 */
export const LONG_LEGITIMATE_NARRATIVE =
  'Che spettacolo questa giornata di Serie A: dieci partite, colpi di scena fino all\'ultimo minuto e un\'atmosfera da grande torneo che ha tenuto tutti con il fiato sospeso. La tua scelta ha centrato l\'esito previsto e ti tiene saldamente in gara: una mossa che parla da sola e che gli altri giocatori non possono ignorare. Il prossimo round si avvicina e la tua squadra gioca di nuovo: prepara la strategia, scegli con cura e invia il tuo pick prima della scadenza per non perdere l\'occasione. Resta concentrato, perché ogni vittoria ti avvicina al titolo: il torneo è ancora tutto da giocare e il pubblico è tutto con te.';

/**
 * Stima prudenziale dei token di un testo (per i test della guardia):
 * massimo tra parole×1.5 e caratteri/3 — un bound alto ma sensato per
 * l'italiano, così l'asserzione "la narrativa entra in TEXT_MAX_TOKENS"
 * resta significativa anche con tokenizer diversi.
 */
export function estimateTokens(text: string): number {
  const words = text.split(/\s+/).length;
  return Math.max(Math.round(words * 1.5), Math.ceil(text.length / 3));
}
