#!/usr/bin/env bash
# =============================================================================
# sl.sh — wrapper "stupido" della CLI Survivor League sulla VPS (D14 del piano
# di deploy). Ruolo: eseguire un comando CLI nell'ambiente indicato
# (staging|prod) senza liste di comandi: fa cd in /opt/survivor/<env> (ogni
# ambiente legge il PROPRIO .env dalla cwd, niente ENV_FILE sulla VPS),
# logga l'invocazione (timestamp UTC, utente, comando) in logs/sl.log, poi
# esegue node dist/index.js "$@". L'exit code del comando si propaga (set -e;
# niente exec, per conservare il log). Nessuna allowlist/blocklist: i comandi
# futuri della CLI funzionano senza modificare lo script.
# Invocazione:  /opt/survivor/sl.sh <staging|prod> <comando> [opzioni]
# (da root: sudo -u survivor /opt/survivor/sl.sh ...; il cron NON usa il
# wrapper: restano i path espliciti del template cron). Installato da
# deploy.sh in /opt/survivor/sl.sh.
# =============================================================================
set -e

# Primo argomento: ambiente (staging|prod); altrimenti messaggio + exit 2.
ENV_NAME="${1:-}"
if [ "$ENV_NAME" != "staging" ] && [ "$ENV_NAME" != "prod" ]; then
  echo "Uso: sl <staging|prod> <comando> [opzioni]" >&2
  echo "Ambiente non valido: '$ENV_NAME' (attesi: staging|prod)" >&2
  exit 2
fi
shift

APP_DIR="/opt/survivor/$ENV_NAME"
cd "$APP_DIR"

# Log dell'invocazione (timestamp UTC, utente e comando) in logs/sl.log.
LOG_DIR="$APP_DIR/logs"
mkdir -p "$LOG_DIR"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] user=$(id -un) cmd=$*" >> "$LOG_DIR/sl.log"

# Esecuzione del comando con la build compilata dell'ambiente.
node dist/index.js "$@"
