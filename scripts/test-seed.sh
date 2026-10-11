#!/usr/bin/env bash
# Runs the DL-01 seed against an empty, migrated PostgreSQL 16 (PostGIS + pgvector):
# two failing loads that must leave nothing behind, then a load and a re-load whose
# rows are checked by db/test/seed/dl_01_loaded.sql. Needs Docker and node_modules.
set -euo pipefail

cd "$(dirname "$0")/.."

SUFFIX="$$"
NETWORK="fieldloop-seed-test-${SUFFIX}"
DB_CONTAINER="fieldloop-seed-test-db-${SUFFIX}"
DB_IMAGE="fieldloop-db-test:pg16"
MIGRATE_IMAGE="${MIGRATE_IMAGE:-fieldloop-db-migrate:test}"
ORG_ID="seed-test-org"
OUTPUT_DIR="$(mktemp -d)"

cleanup() {
  docker rm -f "${DB_CONTAINER}" >/dev/null 2>&1 || true
  docker network rm "${NETWORK}" >/dev/null 2>&1 || true
  rm -rf "${OUTPUT_DIR}"
}
trap cleanup EXIT

run_psql() {
  docker exec -i "${DB_CONTAINER}" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d fieldloop_test "$@"
}

# One "<table> <row count>" line for every table in the app schema.
row_counts() {
  run_psql -At -F ' ' -c "
    SELECT table_name,
           (xpath('/row/c/text()',
                  query_to_xml(format('SELECT count(*) AS c FROM app.%I', table_name), false, true, '')))[1]
    FROM information_schema.tables
    WHERE table_schema = 'app' AND table_type = 'BASE TABLE'
    ORDER BY table_name"
}

# Runs a load that must fail, and fail for the stated reason.
expect_failure() {
  local expected="$1" output
  shift
  if output="$("$@" 2>&1)"; then
    echo "Expected the seed to fail with: ${expected}" >&2
    exit 1
  fi
  if [[ "${output}" != *"${expected}"* ]]; then
    echo "The seed failed for another reason than: ${expected}" >&2
    echo "${output}" >&2
    exit 1
  fi
}

assert_empty() {
  local leftover
  leftover="$(row_counts | awk '$2 != 0')"
  if [ -n "${leftover}" ]; then
    echo "$1 left rows behind:" >&2
    echo "${leftover}" >&2
    exit 1
  fi
}

seed() {
  FIELDLOOP_ORG_ID="${ORG_ID}" FIELDLOOP_DATABASE_URL="${SEED_DATABASE_URL}" \
    node data/synthetic/dl-01/seed.mjs --output-dir "${OUTPUT_DIR}"
}

# Loads the seed file with metadata.classification removed, through the loader's own entry point.
seed_without_classification() {
  FIELDLOOP_ORG_ID="${ORG_ID}" FIELDLOOP_DATABASE_URL="${SEED_DATABASE_URL}" \
    node --input-type=module -e "
      import { readFileSync } from 'node:fs';
      import { Kysely, PostgresDialect } from 'kysely';
      import pg from 'pg';
      import { buildDataset } from './data/synthetic/dl-01/generate.mjs';
      import { loadSeed } from './data/synthetic/dl-01/seed.mjs';
      const bowtieSeed = JSON.parse(readFileSync('./data/synthetic/dl-01/bowtie-a.json', 'utf8'));
      delete bowtieSeed.metadata.classification;
      const pool = new pg.Pool({ connectionString: process.env.FIELDLOOP_DATABASE_URL, max: 1 });
      const database = new Kysely({ dialect: new PostgresDialect({ pool }) });
      try {
        await loadSeed(database, buildDataset(), process.env.FIELDLOOP_ORG_ID, bowtieSeed);
      } finally {
        await database.destroy();
      }
    "
}

echo "==> Building images"
docker build -q -t "${DB_IMAGE}" - < db/test/Dockerfile
docker build -q -t "${MIGRATE_IMAGE}" -f db/Dockerfile .

echo "==> Starting PostgreSQL"
docker network create "${NETWORK}" >/dev/null
docker run -d --name "${DB_CONTAINER}" --network "${NETWORK}" -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=fieldloop_test "${DB_IMAGE}" >/dev/null
# TCP only: the image's init phase listens on the Unix socket alone.
for _ in $(seq 1 60); do
  if docker exec "${DB_CONTAINER}" pg_isready -q -h 127.0.0.1 -U postgres; then break; fi
  sleep 1
done
docker exec "${DB_CONTAINER}" pg_isready -q -h 127.0.0.1 -U postgres

HOST_PORT="$(docker port "${DB_CONTAINER}" 5432/tcp | head -n 1 | sed 's/.*://')"
SEED_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${HOST_PORT}/fieldloop_test"

echo "==> dbmate up (empty database)"
docker run --rm --network "${NETWORK}" \
  -e DATABASE_URL="postgres://postgres:postgres@${DB_CONTAINER}:5432/fieldloop_test?sslmode=disable" \
  "${MIGRATE_IMAGE}" up
assert_empty "The migrations"

echo "==> Seed file without classification is rejected"
expect_failure "metadata.classification" seed_without_classification
assert_empty "The seed file without classification"

# The last table the seed writes rejects its rows, so every earlier insert must roll back.
echo "==> Database error late in the load rolls everything back"
run_psql <<'SQL'
CREATE FUNCTION app.reject_seed_test_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'seed test: evidence rejected';
END $$;
CREATE TRIGGER reject_seed_test_row BEFORE INSERT ON app.evidence
    FOR EACH ROW EXECUTE FUNCTION app.reject_seed_test_row();
SQL
expect_failure "seed test: evidence rejected" seed
assert_empty "The failed seed"
run_psql -c "DROP TRIGGER reject_seed_test_row ON app.evidence; DROP FUNCTION app.reject_seed_test_row();"

echo "==> Seed (empty database)"
seed
run_psql -o /dev/null -v org_id="${ORG_ID}" < db/test/seed/dl_01_loaded.sql
FIRST_COUNTS="$(row_counts)"

echo "==> Seed (second run)"
seed
run_psql -o /dev/null -v org_id="${ORG_ID}" < db/test/seed/dl_01_loaded.sql
SECOND_COUNTS="$(row_counts)"
if [ "${FIRST_COUNTS}" != "${SECOND_COUNTS}" ]; then
  echo "Row counts changed on the second seed run" >&2
  diff <(echo "${FIRST_COUNTS}") <(echo "${SECOND_COUNTS}") >&2 || true
  exit 1
fi

echo "${SECOND_COUNTS}" | awk '$2 != 0'
echo "Seed tests passed"
