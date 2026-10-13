#!/usr/bin/env bash
# Durable Scenario player/reset integration against disposable PostgreSQL. No cloud writes.
set -euo pipefail
cd "$(dirname "$0")/.."
player_suffix="$$"
player_db="fieldloop-player-db-${player_suffix}"
player_network="fieldloop-player-${player_suffix}"
cleanup() {
  docker rm -f "${player_db}" >/dev/null 2>&1 || true
  docker network rm "${player_network}" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker build -q -t fieldloop-db-test:pg16 - < db/test/Dockerfile
docker build -q -t fieldloop-db-migrate:player -f db/Dockerfile .
docker network create "${player_network}" >/dev/null
docker run -d --name "${player_db}" --network "${player_network}" -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=fieldloop_test fieldloop-db-test:pg16 >/dev/null
for _ in $(seq 1 60); do
  if docker exec "${player_db}" pg_isready -q -h 127.0.0.1 -U postgres; then break; fi
  sleep 1
done
docker run --rm --network "${player_network}" \
  -e DATABASE_URL="postgres://postgres:postgres@${player_db}:5432/fieldloop_test?sslmode=disable" \
  fieldloop-db-migrate:player up
player_address="$(docker port "${player_db}" 5432/tcp)"
FIELDLOOP_ENV=local FIELDLOOP_DATABASE_URL="postgres://postgres:postgres@${player_address}/fieldloop_test?sslmode=disable" \
  uv run --locked --all-packages python scripts/test-simulation.py
