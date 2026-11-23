#!/usr/bin/env bash
set -uo pipefail

BASE="/home/sparrow/HomeLab/security/clamav"
REPORT="$BASE/reports/scan-$(date +%F-%H%M%S).log"
COMPOSE="$BASE/docker-compose.yml"

mkdir -p "$BASE/reports"
# Храним отчёты за последние 60 дней.
find "$BASE/reports" -name 'scan-*.log' -mtime +60 -delete 2>/dev/null || true

# Контейнер остановится после проверки даже при ошибке.
cleanup() {
  docker compose -f "$COMPOSE" stop clamav >/dev/null 2>&1 || true
}
trap cleanup EXIT

{
  echo "ClamAV scheduled scan"
  echo "Started: $(date -Is)"
  echo "Targets: HomeLab, Downloads, media"
  echo

  # Свежий образ; сигнатуры freshclam обновляет сам при старте.
  docker compose -f "$COMPOSE" pull -q clamav >/dev/null 2>&1 || true

  if ! docker compose -f "$COMPOSE" up -d clamav; then
    echo "ERROR: failed to start ClamAV container"
    exit 2
  fi

  echo "Waiting for ClamAV daemon..."

  READY=0
  for i in $(seq 1 120); do
    if docker exec clamav clamdscan --ping=1:1 >/dev/null 2>&1; then
      READY=1
      break
    fi
    sleep 5
  done

  if [ "$READY" -ne 1 ]; then
    echo "ERROR: ClamAV daemon did not become ready"
    docker logs --tail 80 clamav
    exit 2
  fi

  echo "Daemon ready: $(date -Is)"
  echo

  docker exec clamav clamdscan \
    --fdpass \
    --infected \
    --verbose \
    /scan/homelab /scan/downloads /scan/media
  RESULT=$?

  echo
  echo "ClamAV exit code: $RESULT"
  echo "Finished: $(date -Is)"
  exit "$RESULT"
} > "$REPORT" 2>&1
