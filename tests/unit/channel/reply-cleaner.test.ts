/**
 * Unit test del Reply Cleaner (piano email-reply-quote-stripping, D1-D9;
 * report di analisi UAT 2026-08-22 §2).
 *
 * Verificano `extractPlayerReply`: funzione PURA che estrae dal body di una
 * reply email SOLO il testo del giocatore (max 5 righe non vuote), tagliando
 * la citazione della mail precedente del sistema al primo "confine di
 * citazione" (separatore `SYSTEM_EMAIL_SEPARATOR` / riga `>` / marker
 * "ha scritto:" / "wrote:"). Nessuna rete, nessun DB: test piccoli e
 * deterministici. Includono i body REALI verbatim dell'incidente UAT
 * (UID 291/293/295) come regressione sui problemi Pippi/Fulvio.
 */
import { describe, expect, it } from 'vitest';

import { SYSTEM_EMAIL_SEPARATOR, extractPlayerReply } from '../../../src/channel/email-adapter/reply-cleaner.js';

describe('SYSTEM_EMAIL_SEPARATOR (D2/D9)', () => {
  it('è la stringa provvisoria condivisa tra invio e ricezione', () => {
    expect(SYSTEM_EMAIL_SEPARATOR).toBe('───');
  });
});

describe('extractPlayerReply (D4/D5/D8)', () => {
  it('body con solo il pick → invariato', () => {
    expect(extractPlayerReply('catanzaro')).toBe('catanzaro');
  });

  it('pick + citazione con marker "Il giorno … ha scritto:" → solo il pick', () => {
    const body =
      'vado di Inter win\n\nIl giorno sab 22 ago 2026 alle ore 20:11 <survivorleague755@gmail.com> ha scritto:\n\n> Ciao!';
    expect(extractPlayerReply(body)).toBe('vado di Inter win');
  });

  it('pick + citazione con marker inglese "wrote:" → solo il pick', () => {
    const body = 'Juve win\n\nOn Sat, 22 Aug 2026 wrote:\n\n> Hello!';
    expect(extractPlayerReply(body)).toBe('Juve win');
  });

  it('pick + citazione con marker "… ha" + "scritto:" spezzato su due righe (wrapping Gmail) → solo il pick', () => {
    const body =
      'catanzaro\n\nIl giorno sab 22 ago 2026 alle ore 20:15 <survivorleague755@gmail.com> ha\nscritto:\n\n> Ciao!';
    expect(extractPlayerReply(body)).toBe('catanzaro');
  });

  it('pick + citazione con righe ">" senza marker → solo il pick', () => {
    const body = 'catanzaro\n\n> Ciao Fulvio!\n> Il round è aperto';
    expect(extractPlayerReply(body)).toBe('catanzaro');
  });

  it('pick + citazione che inizia con "> ───" (separatore citato) → solo il pick', () => {
    const body = `catanzaro\n\n> ${SYSTEM_EMAIL_SEPARATOR}\n> [TEST MODE] banner\n> Ciao!`;
    expect(extractPlayerReply(body)).toBe('catanzaro');
  });

  it('pick + citazione con separatore SENZA prefisso ">" → solo il pick', () => {
    const body = `catanzaro\n\n${SYSTEM_EMAIL_SEPARATOR}\nCiao!`;
    expect(extractPlayerReply(body)).toBe('catanzaro');
  });

  it('testo del giocatore oltre 5 righe non vuote → prime 5 righe non vuote', () => {
    expect(extractPlayerReply('r1\nr2\nr3\nr4\nr5\nr6\nr7')).toBe('r1\nr2\nr3\nr4\nr5');
  });

  it('righe vuote interposte nel testo del giocatore → contano solo le non vuote', () => {
    expect(extractPlayerReply('a\n\nb\n\n\nc')).toBe('a\nb\nc');
  });

  it('body solo-whitespace o vuoto → invariato (il router lo gestisce come oggi)', () => {
    expect(extractPlayerReply('')).toBe('');
    expect(extractPlayerReply('   ')).toBe('');
  });

  it('solo citazione, nessun testo del giocatore → fallback al body originale trimmato (D6)', () => {
    const body = '> [TEST MODE] This email was sent by a test instance of Survivor League.\n>\n> Ciao!';
    expect(extractPlayerReply(body)).toBe(body);
  });

  it('CRLF → trattato come LF (D8)', () => {
    expect(extractPlayerReply('catanzaro\r\n\r\n> Ciao!\r\n> ciao2')).toBe('catanzaro');
  });

  it('separatore scritto dal giocatore a inizio riga (falso positivo) → taglia lì (il separatore vince sempre)', () => {
    expect(extractPlayerReply(`ciao\n${SYSTEM_EMAIL_SEPARATOR}\nquesto è il mio pick`)).toBe('ciao');
  });
});

describe('extractPlayerReply — regressione UAT 2026-08-22 (body verbatim)', () => {
  it('UID 291 ("cremonese pareggia" + citazione TC5) → cremonese pareggia', () => {
    const body = `cremonese pareggia

Il giorno sab 22 ago 2026 alle ore 20:11 <survivorleague755@gmail.com> ha
scritto:

> [TEST MODE] This email was sent by a test instance of Survivor League.
>
> Round 3 · Turno di campionato 5
>
> Ciao Fulvio De Giovanni!
>
> ╔══════════════════════════════════════╗
> ║ ⏰ DEADLINE PICK                      ║
> ║ ──────────────────────────────────── ║
> ║ sabato 22 agosto 2026 alle ore 21:40 ║
> ║ Mancano circa 1 ora e 28 minuti      ║
> ╚══════════════════════════════════════╝
>
> Ciao Fulvio! 😊 Il round è aperto e ci sono tre squadre fantastiche tra
> cui scegliere: Brescia Calcio, SSC Bari e US Catanzaro. Scegli la tua
> squadra vincente e invia il tuo pick prima della scadenza! Forza, non
> perdere tempo! 💪
>
> ╔════════════════════════╗
> ║ 🔒 SQUADRE BRUCIATE    ║
> ║ ────────────────────── ║
> ║ US Cremonese — Round 2 ║
> ╚════════════════════════╝
>
> ⚽ PARTITE DEL ROUND
> US Catanzaro - Brescia Calcio: 0-1
> US Cremonese - SSC Bari: 2-2
>
> ➡️ COSA FARE ORA
> Rispondi a questa email indicando squadra ed esito (win, draw, lose) prima
> della scadenza.`;
    expect(extractPlayerReply(body)).toBe('cremonese pareggia');
  });

  it('UID 293 ("catanzaro" + citazione TC6) → catanzaro', () => {
    const body = `catanzaro

Il giorno sab 22 ago 2026 alle ore 20:15 <survivorleague755@gmail.com> ha
scritto:

> [TEST MODE] This email was sent by a test instance of Survivor League.
>
> Round 4 · Turno di campionato 6
>
> Ciao Fulvio De Giovanni!
>
> ╔══════════════════════════════════════╗
> ║ ⏰ DEADLINE PICK                      ║
> ║ ──────────────────────────────────── ║
> ║ sabato 22 agosto 2026 alle ore 21:55 ║
> ║ Mancano circa 1 ora e 40 minuti      ║
> ╚══════════════════════════════════════╝
>
> Ciao Fulvio! 🎉 Il round è aperto e ci sono due squadre fantastiche tra
> cui scegliere: Brescia Calcio e SSC Bari. Scegli la tua squadra preferita e
> l'esito previsto per il tuo prossimo pick vincente! Non dimenticare di
> inviare la tua scelta prima della scadenza. Forza, Fulvio! 💪
>
> ╔════════════════════════╗
> ║ 🔒 SQUADRE BRUCIATE    ║
> ║ ────────────────────── ║
> ║ US Cremonese — Round 2 ║
> ║ US Catanzaro — Round 3 ║
> ╚════════════════════════╝
>
> ⚽ PARTITE DEL ROUND
> SSC Bari - US Catanzaro: 2-0
> US Cremonese - Brescia Calcio: 3-0
>
> ➡️ COSA FARE ORA
> Rispondi a questa email indicando squadra ed esito (win, draw, lose) prima
> della scadenza.`;
    expect(extractPlayerReply(body)).toBe('catanzaro');
  });

  it('UID 295 ("Catanzaro pareggia" + citazione del rifiuto) → Catanzaro pareggia', () => {
    const body = `Catanzaro pareggia

Il sab 22 ago 2026, 20:19 <survivorleague755@gmail.com> ha scritto:

> [TEST MODE] This email was sent by a test instance of Survivor League.
>
> Round 4 · Turno di campionato 6
>
> Ciao Pippi!
>
> ╔══════════════════════════════════════╗
> ║ ⏰ DEADLINE PICK                      ║
> ║ ──────────────────────────────────── ║
> ║ sabato 22 agosto 2026 alle ore 21:55 ║
> ║ Mancano circa 1 ora e 36 minuti      ║
> ╚══════════════════════════════════════╝
>
> Ciao! Mi dispiace, ma la tua squadra SSC Bari è già stata usata in questo
> turno. Non preoccuparti, puoi riprovare con una nuova email e scegliere
> un'altra squadra per il tuo pronostico. In bocca al lupo! 🐺🍀
>
> ➡️ COSA FARE ORA
> Riprova rispondendo a questa email con squadra ed esito (win, draw, lose).`;
    expect(extractPlayerReply(body)).toBe('Catanzaro pareggia');
  });
});
