# Guida al deploy VPS — Survivor League

Guida operativa breve per portare i cambiamenti del codice sul VPS di
produzione (`staging` e `prod`). Valida per **umani** (commissioner
non-sviluppatore) e **agenti** che amministrano il torneo.

## 1. Prerequisiti

- Accesso SSH al VPS senza password: `ssh survivor-vps` (hostname
  `srv1822163`, alias configurato in `~/.ssh/config`).
- Il codice da rilasciare è **già su `main`** del repo GitHub (push
  completato: `git push origin main`).
- **Prima installazione già eseguita** (una tantum, Fasi 1–7 del piano di
  deploy): utente `survivor` creato, deploy key read-only attiva, clone in
  `/opt/survivor/{staging,prod}`, `.env` compilati, DB migrati, crontab
  installato, wrapper `sl` presente in `/opt/survivor/sl.sh`.
- Node.js ≥ 20.12 installato (`/usr/bin/node`); `build-essential` presente.

## 2. Flusso ripetibile (deploy di un nuovo codice)

1. **Push su `main`** (da locale):

   ```bash
   git push origin main
   ```

2. **Deploy di staging** (prova prima, sempre):

   ```bash
   ssh survivor-vps 'sudo -u survivor /opt/survivor/deploy.sh staging'
   ```

3. **Verifica staging** con il wrapper (vedi `scripts/sl.sh`):

   ```bash
   ssh survivor-vps 'sudo -u survivor /opt/survivor/sl.sh staging tournament:status'
   ```

4. **Deploy di prod** solo quando si decide di rilasciare:

   ```bash
   ssh survivor-vps 'sudo -u survivor /opt/survivor/deploy.sh prod'
   ```

   Conferma finale:

   ```bash
   ssh survivor-vps 'sudo -u survivor /opt/survivor/sl.sh prod tournament:status'
   ```

Il deploy di un ambiente è **idempotente**: può essere rieseguito senza
effetti collaterali.

## 3. Cosa fa `deploy.sh`, cosa NON fa

**Fa** (nell'ordine, fermandosi al primo errore — `set -e`):

1. `git fetch origin` + `git reset --hard origin/main` (allineamento del
   codice; i file non tracciati — `.env`, `data/`, `dist/` — non vengono
   toccati dal reset);
2. `npm ci` (dipendenze esatte da `package-lock.json`);
3. `npm run build` (build compilata `tsc` → `dist/`, con copia delle risorse
   non-TS in `dist/`, es. `team-aliases*.md`);
4. `db:migrate` + `platform:migrate` (idempotenti);
5. **installazione del crontab dal template versionato**
   `scripts/cron/survivor.cron` (vedi §4);
6. copia del wrapper `scripts/sl.sh` → `/opt/survivor/sl.sh`;
7. smoke `tournament:status` + riga riepilogativa con timestamp in
   `logs/deploy.log`.

**Non fa**:

- **non tocca mai `.env`** (se manca lo crea da `.env.example`, ma se esiste
  non lo sovrascrive mai: le credenziali e i parametri di ambiente
  sopravvivono a ogni deploy);
- **non tocca `data/`**: lo stato del torneo (DB, log, export) sopravvive;
- **non riavvia nulla**: il cron esegue la nuova `dist/` al tick successivo.

## 4. Parte cron (gestita dal template, non a mano)

Il crontab **non si aggiorna a mano** (niente `crontab -e`): vive nel template
**versionato nel repo** `scripts/cron/survivor.cron` (4 righe, 2 per
ambiente — `staging` e `prod`), e `deploy.sh` lo installa a ogni deploy
(sostituisce l'intero crontab dell'utente `survivor` col template).

**Ogni futura modifica alle righe cron si fa solo nel template nel repo** e
arriva sul VPS col prossimo deploy.

A torneo chiuso lo scheduler è inibito e i tick sono **innocui**: non serve
rimuovere righe; `channel:email:process` resta attivo (iscrizioni e
chiarimenti continuano a funzionare).

## 5. Verifica post-deploy

```bash
# Stato del torneo (deve rispondere; staging mostra il banner TEST MODE)
ssh survivor-vps 'sudo -u survivor /opt/survivor/sl.sh prod tournament:status'
ssh survivor-vps 'sudo -u survivor /opt/survivor/sl.sh staging tournament:status'

# Crontab: deve coincidere col template (4 righe, 2 per ambiente)
ssh survivor-vps 'crontab -u survivor -l'

# Log del deploy e delle esecuzioni cron (i file avanzano ogni minuto)
ssh survivor-vps 'tail -5 /opt/survivor/prod/logs/deploy.log'
ssh survivor-vps 'tail -5 /opt/survivor/prod/logs/cron.log'
ssh survivor-vps 'tail -5 /opt/survivor/prod/logs/sl.log'
```

## 6. Rollback

Per tornare a un commit precedente **in un singolo ambiente**:

```bash
ssh survivor-vps "sudo -u survivor bash -c 'cd /opt/survivor/<env> && git checkout <sha-precedente> && npm run build'"
```

Esempio: `… git checkout 4cd8fd8 && npm run build …`. Nota: il **prossimo**
`deploy.sh` riallinea l'ambiente a `origin/main` (il rollback è quindi una
misura temporanea di emergenza). Non tocca `.env` né `data/`.

## 7. Troubleshooting rapido

| Sintomo | Causa probabile | Azione |
|---|---|---|
| `deploy.sh` fallisce su build/smoke | Codice su `main` non compilabile o dipendenze rotte | Leggi l'errore nel log; correggi su `main` e rilancia il deploy |
| `git ls-remote` come `survivor` dà errore | Deploy key rimossa o scaduta | Rigienera/riaggiungi la deploy key read-only su GitHub (Settings → Deploy keys) |
| `sl pippo …` esce con codice 2 | Ambiente errato (attesi `staging`\|`prod`) | Controlla il nome ambiente |
| `logs/cron.log` non avanza | Cron non attivo o crontab manomesso | `crontab -u survivor -l` e confronta col template; reinstalla con `deploy.sh` |
| Email non processate | Credenziali IMAP mancanti nel `.env` dell'ambiente | Compila `IMAP_USER`/`IMAP_PASS` in `/opt/survivor/<env>/.env` e verifica con `sl <env> channel:email:fetch` |
| `refresh_failed` nei tick di prod | `FOOTBALL_DATA_TOKEN` mancante o non valido | Compila il token reale nel `.env` di prod |
