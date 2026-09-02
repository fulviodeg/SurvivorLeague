#!/usr/bin/env bash
# =============================================================================
# deploy.sh — deploy ripetibile di un ambiente Survivor League sulla VPS
# (decisioni D3/D5/D13/D15 del piano di deploy). Ruolo: portare l'ambiente
# indicato (staging|prod) allineato a origin/main in modo deterministico e
# idempotente, SENZA mai toccare .env (lo crea da .env.example solo se
# assente, D13) né data/ (lo stato del torneo sopravvive al deploy).
# Invocazione (sulla VPS):  sudo -u survivor /opt/survivor/deploy.sh <env>
# Sequenza: pull da origin/main -> npm ci -> build -> migrate (idempotenti) ->
# installazione crontab dal template versionato (D15) -> copia wrapper sl.sh
# (D14) -> smoke tournament:status -> log riepilogativo in logs/deploy.log.
# set -e: il deploy si ferma al primo errore (nessun rilascio parziale).
# =============================================================================
set -e

# Primo argomento: ambiente target (staging|prod); qualsiasi altro valore
# termina con exit 2 (stesso contratto del wrapper sl.sh).
ENV_NAME="${1:-}"
if [ "$ENV_NAME" != "staging" ] && [ "$ENV_NAME" != "prod" ]; then
  echo "Uso: deploy.sh <staging|prod>" >&2
  exit 2
fi

APP_DIR="/opt/survivor/$ENV_NAME"
cd "$APP_DIR"

# Log riepilogativo del deploy (timestamp UTC) in logs/deploy.log.
DEPLOY_LOG="$APP_DIR/logs/deploy.log"
mkdir -p "$(dirname "$DEPLOY_LOG")"
log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$DEPLOY_LOG"
}

log "=== deploy $ENV_NAME: inizio ==="

# 1. Allineamento del codice a origin/main (fetch + reset hard: i file non
#    tracciati — .env, data/, dist/ — NON vengono toccati dal reset).
git fetch origin
git reset --hard origin/main
log "git allineato a origin/main ($(git rev-parse --short HEAD))"

# 2. Dipendenze: npm ci installa anche le dev-dependencies (necessarie alla
#    build compilata).
npm ci --no-audit --no-fund

# 3. Build compilata (tsc -> dist/; il comando build copia anche le risorse
#    non-TS in dist/, es. team-aliases*.md del parser deterministico).
npm run build

# 4. Migrazioni dei due database (torneo e piattaforma), idempotenti.
node dist/index.js db:migrate
node dist/index.js platform:migrate

# 5. Crontab dal template versionato (D15): sostituisce il crontab di survivor
#    col template (4 righe, entrambi gli ambienti). Nessuna modifica a mano:
#    le future modifiche alle righe cron si fanno solo nel template nel repo.
crontab scripts/cron/survivor.cron
log "crontab installato dal template scripts/cron/survivor.cron"

# 6. Wrapper CLI (D14): copia scripts/sl.sh -> /opt/survivor/sl.sh (eseguibile,
#    owner survivor: il deploy gira come survivor).
cp scripts/sl.sh /opt/survivor/sl.sh
chmod +x /opt/survivor/sl.sh

# 7. Smoke: tournament:status deve rispondere (con .env compilato e DB migrati).
node dist/index.js tournament:status >/dev/null
log "smoke tournament:status OK"

log "=== deploy $ENV_NAME: completato ==="
