/**
 * Test unitari della configurazione (LLD §4, §4.5).
 * Verificano che parseConfig applichi i default documentati, converta i tipi
 * (numeri, booleani) e rifiuti l'avvio con un messaggio esplicito che nomina
 * la variabile mancante/invalida. I test sono ermetici: operano su un record
 * passato esplicitamente, senza toccare process.env né file .env.
 */
import process from 'node:process';

import { describe, expect, it, vi, afterEach } from 'vitest';

import { ConfigError, loadEnvFile, parseConfig } from '../../src/config.js';

/** Record con tutte le variabili richieste valorizzate: base valida per i test. */
const requiredEnv: Record<string, string> = {
  IMAP_USER: 'poc@gmail.com',
  IMAP_PASS: 'imap-app-password',
  SMTP_USER: 'poc@gmail.com',
  SMTP_PASS: 'smtp-app-password',
  LLM_API_KEY: 'sk-test',
  FOOTBALL_DATA_TOKEN: 'football-data-token'
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('parseConfig', () => {
  it('applica tutti i default di LLD §4 quando sono presenti solo le variabili richieste', () => {
    const config = parseConfig({ ...requiredEnv });

    // §4.1 parametri di gioco
    expect(config.DEADLINE_ADVANCE_MIN).toBe(30);
    expect(config.TC_CLOSE_SKEW_MIN).toBe(300);
    expect(config.MATCH_DURATION_MIN).toBe(125);
    expect(config.MAX_PROFILES_PER_PLAYER).toBe(1);
    expect(config.ENTRY_FEE_EUR).toBe(5);
    expect(config.WINNER_SHARE_PCT).toBe(85);
    expect(config.WIN_ONLY).toBe(true);
    // §4.2 parametri infrastruttura
    expect(config.IMAP_HOST).toBe('imap.gmail.com');
    expect(config.IMAP_PORT).toBe(993);
    expect(config.SMTP_HOST).toBe('smtp.gmail.com');
    expect(config.SMTP_PORT).toBe(587);
    expect(config.LLM_API_BASE_URL).toBe('https://api.openai.com/v1');
    expect(config.LLM_MODEL).toEqual(['gpt-4o-mini']);
    expect(config.LLM_TIMEOUT_MS).toBe(15000);
    expect(config.LLM_RETRIES).toBe(3);
    expect(config.AI_EMAIL_GENERATOR).toBe(false);
    expect(config.AI_EMAIL_PARSER).toBe(false);
    expect(config.DB_PATH).toBe('./data/survivor.db');
    expect(config.TIMEZONE).toBe('Europe/Rome');
    expect(config.TOURNAMENT_EXPORT_DIR).toBe('./data/exports/');
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.IMAP_POLL_MS).toBe(60000);
    // §4.3 parametri dati stagione
    expect(config.FOOTBALL_DATA_BASE_URL).toBe('https://api.football-data.org');
    expect(config.FOOTBALL_DATA_COMPETITION).toBe('SA');
    expect(config.FOOTBALL_DATA_SEASON).toBe(2025);
    // §4.4 parametri scheduler
    expect(config.SCHEDULER_ENABLED).toBe(false);
    expect(config.SCHEDULER_TICK_MIN).toBe(1);
    expect(config.SCHEDULER_AUTO_SCORE).toBe(true);
    // Simulazione (decisione 11 del piano)
    expect(config.SIM_PLAYERS).toBe(10);
  });

  it('converte numeri e booleani dalle stringhe delle env var', () => {
    const config = parseConfig({
      ...requiredEnv,
      DEADLINE_ADVANCE_MIN: '45',
      IMAP_PORT: '1993',
      FOOTBALL_DATA_SEASON: '2026',
      SCHEDULER_ENABLED: 'true',
      SCHEDULER_AUTO_SCORE: 'false',
      SIM_PLAYERS: '20',
      LLM_TIMEOUT_MS: '20000',
      LLM_RETRIES: '5',
      AI_EMAIL_GENERATOR: 'true',
      WIN_ONLY: 'true'
    });

    expect(config.DEADLINE_ADVANCE_MIN).toBe(45);
    expect(config.IMAP_PORT).toBe(1993);
    expect(config.FOOTBALL_DATA_SEASON).toBe(2026);
    expect(config.SCHEDULER_ENABLED).toBe(true);
    expect(config.SCHEDULER_AUTO_SCORE).toBe(false);
    expect(config.SIM_PLAYERS).toBe(20);
    expect(config.LLM_TIMEOUT_MS).toBe(20000);
    expect(config.LLM_RETRIES).toBe(5);
    expect(config.AI_EMAIL_GENERATOR).toBe(true);
    expect(config.WIN_ONLY).toBe(true);
  });

  it('LLM_MODEL: lista separata da virgola → array (trim, scarto vuoti, dedup ordinato)', () => {
    expect(parseConfig({ ...requiredEnv, LLM_MODEL: 'a' }).LLM_MODEL).toEqual(['a']);
    expect(parseConfig({ ...requiredEnv, LLM_MODEL: 'a, b ,c' }).LLM_MODEL).toEqual(['a', 'b', 'c']);
    expect(parseConfig({ ...requiredEnv, LLM_MODEL: 'a,,b' }).LLM_MODEL).toEqual(['a', 'b']);
    expect(parseConfig({ ...requiredEnv, LLM_MODEL: 'a,a,b' }).LLM_MODEL).toEqual(['a', 'b']);
  });

  it('LLM_MODEL: lista vuota ("" o ",,") → ConfigError che nomina la variabile', () => {
    expect(() => parseConfig({ ...requiredEnv, LLM_MODEL: '' })).toThrowError(/LLM_MODEL/);
    expect(() => parseConfig({ ...requiredEnv, LLM_MODEL: ',,' })).toThrowError(/LLM_MODEL/);
  });

  it('rifiuta l’avvio se manca una variabile richiesta, nominandola nel messaggio', () => {
    const env = { ...requiredEnv };
    delete env.IMAP_USER;

    expect(() => parseConfig(env)).toThrowError(/IMAP_USER/);
  });

  it('nomina nel messaggio tutte le variabili richieste mancanti', () => {
    expect(() => parseConfig({})).toThrowError(
      /IMAP_USER[\s\S]*IMAP_PASS[\s\S]*SMTP_USER[\s\S]*SMTP_PASS[\s\S]*FOOTBALL_DATA_TOKEN/
    );
  });

  it('tratta una variabile richiesta vuota come mancante', () => {
    expect(() => parseConfig({ ...requiredEnv, IMAP_PASS: '' })).toThrowError(/IMAP_PASS/);
  });

  it('rifiuta un valore non numerico per una variabile numerica, nominandola', () => {
    expect(() => parseConfig({ ...requiredEnv, IMAP_PORT: 'abc' })).toThrowError(/IMAP_PORT/);
  });

  it('rifiuta un LOG_LEVEL fuori enum, nominandolo', () => {
    expect(() => parseConfig({ ...requiredEnv, LOG_LEVEL: 'verbose' })).toThrowError(/LOG_LEVEL/);
  });

  describe('LLM_API_KEY condizionale + AI_EMAIL_PARSER (email v3 Parte B)', () => {
    const noAi = {
      IMAP_USER: 'u',
      IMAP_PASS: 'p',
      SMTP_USER: 'u',
      SMTP_PASS: 'p',
      FOOTBALL_DATA_TOKEN: 't'
    };

    it('con entrambi i flag AI false la config è valida SENZA LLM_API_KEY', () => {
      const config = parseConfig(noAi);
      expect(config.AI_EMAIL_GENERATOR).toBe(false);
      expect(config.AI_EMAIL_PARSER).toBe(false);
      expect(config.LLM_API_KEY).toBe('');
    });

    it('con AI_EMAIL_GENERATOR=true e LLM_API_KEY assente → ConfigError che nomina LLM_API_KEY', () => {
      expect(() => parseConfig({ ...noAi, AI_EMAIL_GENERATOR: 'true' })).toThrowError(/LLM_API_KEY/);
    });

    it('con AI_EMAIL_PARSER=true e LLM_API_KEY assente → ConfigError che nomina LLM_API_KEY', () => {
      expect(() => parseConfig({ ...noAi, AI_EMAIL_PARSER: 'true' })).toThrowError(/LLM_API_KEY/);
    });

    it('con AI_EMAIL_GENERATOR=true e LLM_API_KEY valorizzata → valida', () => {
      expect(parseConfig({ ...noAi, AI_EMAIL_GENERATOR: 'true', LLM_API_KEY: 'k' }).LLM_API_KEY).toBe('k');
    });

    it('AI_EMAIL_PARSER: default false e conversione booleana', () => {
      expect(parseConfig(noAi).AI_EMAIL_PARSER).toBe(false);
      expect(parseConfig({ ...noAi, AI_EMAIL_PARSER: 'true', LLM_API_KEY: 'k' }).AI_EMAIL_PARSER).toBe(true);
    });
  });

  describe('TIMEZONE e TOURNAMENT_EXPORT_DIR (ADR-011)', () => {
    it('TIMEZONE valida → accettata; default Europe/Rome', () => {
      expect(parseConfig({ ...requiredEnv }).TIMEZONE).toBe('Europe/Rome');
      expect(parseConfig({ ...requiredEnv, TIMEZONE: 'America/New_York' }).TIMEZONE).toBe(
        'America/New_York'
      );
    });

    it('TIMEZONE non IANA → ConfigError che nomina la variabile (validazione al boot)', () => {
      expect(() => parseConfig({ ...requiredEnv, TIMEZONE: 'Marte/Roma' })).toThrowError(/TIMEZONE/);
      expect(() => parseConfig({ ...requiredEnv, TIMEZONE: '' })).toThrowError(/TIMEZONE/);
    });

    it('TOURNAMENT_EXPORT_DIR: default e override', () => {
      expect(parseConfig({ ...requiredEnv }).TOURNAMENT_EXPORT_DIR).toBe('./data/exports/');
      expect(
        parseConfig({ ...requiredEnv, TOURNAMENT_EXPORT_DIR: '/tmp/exports' }).TOURNAMENT_EXPORT_DIR
      ).toBe('/tmp/exports');
    });
  });

  describe('test mode (§0.1/D9, gating a consumo §0.3)', () => {
    it('default: testMode=false e parametri test-only disattivati (regressione)', () => {
      const config = parseConfig({ ...requiredEnv });
      expect(config.testMode).toBe(false);
      expect(config.TEST_MODE).toBe(false);
      expect(config.TEST_OFFSET_DAYS).toBe(0);
      expect(config.TEST_REFRESH_ALLOWED).toBe(false);
    });

    it('TEST_MODE=true → testMode=true (e TEST_MODE coerente)', () => {
      const config = parseConfig({ ...requiredEnv, TEST_MODE: 'true' });
      expect(config.testMode).toBe(true);
      expect(config.TEST_MODE).toBe(true);
    });

    it('parametri test-only: valori validi convertiti ai tipi attesi', () => {
      const config = parseConfig({
        ...requiredEnv,
        TEST_MODE: 'true',
        TEST_OFFSET_DAYS: '7',
        TEST_REFRESH_ALLOWED: 'true'
      });
      expect(config.testMode).toBe(true);
      expect(config.TEST_OFFSET_DAYS).toBe(7);
      expect(config.TEST_REFRESH_ALLOWED).toBe(true);
    });

    it('parametro test-only malformato → default SENZA errore (gating a consumo)', () => {
      // Con TEST_MODE=false un env copiato per sbaglio con valori spuri non deve
      // far fallire l'avvio: resta il default (0/false), nessun effetto.
      const config = parseConfig({
        ...requiredEnv,
        TEST_MODE: 'false',
        TEST_OFFSET_DAYS: 'abc',
        TEST_REFRESH_ALLOWED: 'si'
      });
      expect(config.testMode).toBe(false);
      expect(config.TEST_OFFSET_DAYS).toBe(0);
      expect(config.TEST_REFRESH_ALLOWED).toBe(false);
    });

    it('TEST_OFFSET_DAYS negativo o vuoto → 0 (default)', () => {
      expect(parseConfig({ ...requiredEnv, TEST_OFFSET_DAYS: '-5' }).TEST_OFFSET_DAYS).toBe(0);
      expect(parseConfig({ ...requiredEnv, TEST_OFFSET_DAYS: '' }).TEST_OFFSET_DAYS).toBe(0);
      expect(parseConfig({ ...requiredEnv, TEST_OFFSET_DAYS: '3.5' }).TEST_OFFSET_DAYS).toBe(0);
    });
  });
});

describe('loadEnvFile (§0.2: ENV_FILE esplicito vs default silenzioso)', () => {
  it('ENV_FILE esplicito ma inesistente → ConfigError che nomina il path', () => {
    vi.stubEnv('ENV_FILE', './inesistente-xyz.env');
    vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {
      const err = new Error('ENOENT: no such file') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    expect(() => loadEnvFile()).toThrowError(ConfigError);
    expect(() => loadEnvFile()).toThrowError(/inesistente-xyz\.env/);
  });

  it('ENV_FILE assente (default .env) → ENOENT silenzioso (nessun errore)', () => {
    vi.stubEnv('ENV_FILE', undefined);
    vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {
      const err = new Error('ENOENT: no such file') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    expect(() => loadEnvFile()).not.toThrow();
  });

  it('errore non-ENOENT (es. permessi) → rilanciato', () => {
    vi.stubEnv('ENV_FILE', undefined);
    vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });
    expect(() => loadEnvFile()).toThrowError(/EACCES/);
  });
});
