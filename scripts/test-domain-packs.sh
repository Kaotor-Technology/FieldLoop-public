#!/usr/bin/env bash
# Disposable PostGIS database: register both demo packs using the application role.
set -euo pipefail
cd "$(dirname "$0")/.."
PACK_TEST_SUFFIX="$$"
PACK_TEST_NETWORK="fieldloop-pack-test-${PACK_TEST_SUFFIX}"
PACK_TEST_CONTAINER="fieldloop-pack-test-db-${PACK_TEST_SUFFIX}"
PACK_TEST_DB_IMAGE="fieldloop-db-test:pg16"
PACK_TEST_MIGRATE_IMAGE="${MIGRATE_IMAGE:-fieldloop-db-migrate:test}"
cleanup() {
  docker rm -f "${PACK_TEST_CONTAINER}" >/dev/null 2>&1 || true
  docker network rm "${PACK_TEST_NETWORK}" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker build -q -t "${PACK_TEST_DB_IMAGE}" - < db/test/Dockerfile
docker build -q -t "${PACK_TEST_MIGRATE_IMAGE}" -f db/Dockerfile .
docker network create "${PACK_TEST_NETWORK}" >/dev/null
docker run -d --rm --name "${PACK_TEST_CONTAINER}" --network "${PACK_TEST_NETWORK}" \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=fieldloop_test \
  -p 127.0.0.1::5432 "${PACK_TEST_DB_IMAGE}" >/dev/null
docker run --rm --network "${PACK_TEST_NETWORK}" \
  -e DATABASE_URL="postgres://postgres:postgres@${PACK_TEST_CONTAINER}:5432/fieldloop_test?sslmode=disable" \
  "${PACK_TEST_MIGRATE_IMAGE}" up
PACK_TEST_ADDRESS="$(docker port "${PACK_TEST_CONTAINER}" 5432/tcp)"
FIELDLOOP_PACK_TEST_DATABASE_URL="postgres://postgres:postgres@${PACK_TEST_ADDRESS}/fieldloop_test?sslmode=disable" \
  node scripts/test-domain-packs.mjs
