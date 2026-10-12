#!/usr/bin/env bash
# Isolated database only; never reads Cloud SQL credentials.
set -euo pipefail
cd "$(dirname "$0")/.."
SUFFIX="$$"
NETWORK="fieldloop-bangkok-test-${SUFFIX}"
DB_CONTAINER="fieldloop-bangkok-test-db-${SUFFIX}"
DB_IMAGE="fieldloop-db-test:pg16"
MIGRATE_IMAGE="fieldloop-db-migrate:test"
SEED_IMAGE="fieldloop-seed-bangkok:test"
cleanup() {
  docker rm -f "${DB_CONTAINER}" >/dev/null 2>&1 || true
  docker network rm "${NETWORK}" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker build -q -t "${DB_IMAGE}" - < db/test/Dockerfile
docker build -q -t "${MIGRATE_IMAGE}" -f db/Dockerfile .
docker build -q -t "${SEED_IMAGE}" -f db/seed/bangkok/Dockerfile .
docker network create "${NETWORK}" >/dev/null
docker run -d --name "${DB_CONTAINER}" --network "${NETWORK}" -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=fieldloop_test "${DB_IMAGE}" >/dev/null
for _ in $(seq 1 60); do
  if docker exec "${DB_CONTAINER}" pg_isready -q -h 127.0.0.1 -U postgres; then break; fi
  sleep 1
done
docker exec "${DB_CONTAINER}" pg_isready -q -h 127.0.0.1 -U postgres
HOST_PORT="$(docker port "${DB_CONTAINER}" 5432/tcp | head -n 1 | sed 's/.*://')"
test -n "${HOST_PORT}"
docker run --rm --network "${NETWORK}" \
  -e DATABASE_URL="postgres://postgres:postgres@${DB_CONTAINER}:5432/fieldloop_test?sslmode=disable" \
  "${MIGRATE_IMAGE}" up
FIELDLOOP_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${HOST_PORT}/fieldloop_test" \
  node scripts/test-bangkok-seed.mjs
# The runtime image needs neither network access to OSM nor a writable dataset directory.
docker run --rm --read-only --network "${NETWORK}" \
  -e FIELDLOOP_ORG_ID=seed-test-org \
  -e FIELDLOOP_DATABASE_URL="postgres://postgres:postgres@${DB_CONTAINER}:5432/fieldloop_test" \
  "${SEED_IMAGE}"
if docker run --rm --network none "${SEED_IMAGE}"; then
  echo 'Image must reject missing Organisation.' >&2
  exit 1
fi
echo 'Bangkok database and image tests passed'
