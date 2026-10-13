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
# A successful seed may reach this isolated database, but cannot reach a public API.
docker network create --internal "${NETWORK}" >/dev/null
docker run -d --name "${DB_CONTAINER}" --network "${NETWORK}" \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=fieldloop_test "${DB_IMAGE}" >/dev/null
for _ in $(seq 1 60); do
  if docker exec "${DB_CONTAINER}" pg_isready -q -h 127.0.0.1 -U postgres; then break; fi
  sleep 1
done
docker exec "${DB_CONTAINER}" pg_isready -q -h 127.0.0.1 -U postgres
docker run --rm --network "${NETWORK}" \
  -e DATABASE_URL="postgres://postgres:postgres@${DB_CONTAINER}:5432/fieldloop_test?sslmode=disable" \
  "${MIGRATE_IMAGE}" up
# Run the assertions inside the same isolated network. Reuse the runtime image's
# pure-JS database dependencies; only this test container needs root to add the link.
docker run --rm --network "${NETWORK}" --user root --entrypoint sh \
  -e FIELDLOOP_DATABASE_URL="postgres://postgres:postgres@${DB_CONTAINER}:5432/fieldloop_test" \
  --mount "type=bind,source=$PWD/scripts/test-bangkok-seed.mjs,target=/app/scripts/test-bangkok-seed.mjs,readonly" \
  --mount "type=bind,source=$PWD/db/seed/dl-01,target=/app/db/seed/dl-01,readonly" \
  --mount "type=bind,source=$PWD/data/synthetic/dl-01,target=/app/data/synthetic/dl-01,readonly" \
  "${SEED_IMAGE}" -c 'ln -s /app/db/seed/bangkok/node_modules /app/node_modules && node /app/scripts/test-bangkok-seed.mjs'
# The runtime image needs neither network access to OSM nor a writable dataset directory.
docker run --rm --read-only --network "${NETWORK}" \
  -e FIELDLOOP_ORG_ID=seed-test-org \
  -e FIELDLOOP_DATABASE_URL="postgres://postgres:postgres@${DB_CONTAINER}:5432/fieldloop_test" \
  "${SEED_IMAGE}"
# Corrupt only this disposable container's snapshot, with no database or network.
set +e
CORRUPT_OUTPUT="$(docker run --rm --network none --user root --entrypoint sh \
  -e FIELDLOOP_ORG_ID=seed-test-org \
  -e FIELDLOOP_DATABASE_URL=postgres://postgres:postgres@invalid.invalid/fieldloop_test \
  "${SEED_IMAGE}" -c 'printf "{}\n" > /app/data/synthetic/bangkok/sources/canals.json && node seed.mjs' 2>&1)"
CORRUPT_STATUS=$?
set -e
test "${CORRUPT_STATUS}" -ne 0
if [[ "${CORRUPT_OUTPUT}" != 'Source hash mismatch: canals.json' ]]; then
  printf 'Unexpected corrupt-source failure: %s\n' "${CORRUPT_OUTPUT}" >&2
  exit 1
fi
if docker run --rm --network none "${SEED_IMAGE}"; then
  echo 'Image must reject missing Organisation.' >&2
  exit 1
fi
echo 'Bangkok database and image tests passed'
