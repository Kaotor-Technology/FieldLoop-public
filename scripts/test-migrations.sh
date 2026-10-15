#!/usr/bin/env bash
# Runs the db-migrate image against an empty PostgreSQL 16 (PostGIS + pgvector):
# up -> roll back every migration -> up, then the SQL regression tests in db/test.
set -euo pipefail

cd "$(dirname "$0")/.."

SUFFIX="$$"
NETWORK="fieldloop-migrate-test-${SUFFIX}"
DB_CONTAINER="fieldloop-migrate-test-db-${SUFFIX}"
DB_IMAGE="fieldloop-db-test:pg16"
MIGRATE_IMAGE="${MIGRATE_IMAGE:-fieldloop-db-migrate:test}"
DATABASE_URL="postgres://postgres:postgres@${DB_CONTAINER}:5432/fieldloop_test?sslmode=disable"

cleanup() {
  docker rm -f "${DB_CONTAINER}" >/dev/null 2>&1 || true
  docker network rm "${NETWORK}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

dbmate() {
  docker run --rm --network "${NETWORK}" -e DATABASE_URL="${DATABASE_URL}" "${MIGRATE_IMAGE}" "$@"
}

run_psql() {
  docker exec -i "${DB_CONTAINER}" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d fieldloop_test "$@"
}

run_psql_database() {
  docker exec -i "${DB_CONTAINER}" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$1" "${@:2}"
}

dbmate_database() {
  local database="$1"
  shift
  docker run --rm --network "${NETWORK}" \
    -e DATABASE_URL="postgres://postgres:postgres@${DB_CONTAINER}:5432/${database}?sslmode=disable" \
    "${MIGRATE_IMAGE}" "$@"
}

echo "==> Building images"
docker build -q -t "${DB_IMAGE}" - < db/test/Dockerfile
docker build -q -t "${MIGRATE_IMAGE}" -f db/Dockerfile .

echo "==> Starting PostgreSQL"
docker network create "${NETWORK}" >/dev/null
docker run -d --name "${DB_CONTAINER}" --network "${NETWORK}" \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=fieldloop_test "${DB_IMAGE}" >/dev/null
# TCP only: the image's init phase listens on the Unix socket alone.
for _ in $(seq 1 60); do
  if docker exec "${DB_CONTAINER}" pg_isready -q -h 127.0.0.1 -U postgres; then break; fi
  sleep 1
done
docker exec "${DB_CONTAINER}" pg_isready -q -h 127.0.0.1 -U postgres

MIGRATION_COUNT="$(find db/migrations -name '*.sql' | wc -l | tr -d ' ')"

echo "==> dbmate up (empty database)"
dbmate up

echo "==> dbmate rollback x${MIGRATION_COUNT}"
for _ in $(seq 1 "${MIGRATION_COUNT}"); do
  dbmate rollback
done
LEFTOVER="$(run_psql -At -c "SELECT (SELECT count(*) FROM public.schema_migrations) + (SELECT count(*) FROM pg_namespace WHERE nspname IN ('app', 'adk'))")"
if [ "${LEFTOVER}" != "0" ]; then
  echo "Rollback left migrations or the app or adk schema behind" >&2
  exit 1
fi

echo "==> dbmate up (after rollback)"
dbmate up

for test_file in db/test/*.sql; do
  echo "==> ${test_file}"
  run_psql -o /dev/null < "${test_file}"
done

# Verify that each BFF IAM identity receives app privileges only in its own database.
echo "==> BFF dev/demo database role isolation"
docker exec -i "${DB_CONTAINER}" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
CREATE ROLE "fl-v2-web-api-dev@example-project.iam" LOGIN;
CREATE ROLE "fl-v2-web-api-demo@example-project.iam" LOGIN;
CREATE ROLE "fl-v2-simulator-dev@example-project.iam" LOGIN;
CREATE ROLE "fl-v2-simulator-demo@example-project.iam" LOGIN;
CREATE ROLE "fl-v2-guardrail-dev@example-project.iam" LOGIN;
CREATE ROLE "fl-v2-guardrail-demo@example-project.iam" LOGIN;
CREATE ROLE "fl-v2-assistant-dev@example-project.iam" LOGIN;
CREATE ROLE "fl-v2-assistant-demo@example-project.iam" LOGIN;
CREATE DATABASE fieldloop_dev;
CREATE DATABASE fieldloop_demo;
SQL
dbmate_database fieldloop_dev up
dbmate_database fieldloop_demo up
run_psql_database fieldloop_dev < db/test/bff_auth_roles.sql
run_psql_database fieldloop_demo < db/test/bff_auth_roles.sql
run_psql_database fieldloop_dev < db/test/simulator_roles.sql
run_psql_database fieldloop_demo < db/test/simulator_roles.sql
run_psql_database fieldloop_dev < db/test/guardrail_roles.sql
run_psql_database fieldloop_demo < db/test/guardrail_roles.sql
run_psql_database fieldloop_dev < db/test/assistant_roles.sql
run_psql_database fieldloop_demo < db/test/assistant_roles.sql
run_psql_database fieldloop_dev < db/test/action_requests.sql
run_psql_database fieldloop_demo < db/test/action_requests.sql
run_psql_database fieldloop_dev < db/test/audit_append_roles.sql
run_psql_database fieldloop_demo < db/test/audit_append_roles.sql

# Cloud SQL shape: the extensions already exist and the migrating role is not a superuser.
echo "==> dbmate up as a non-superuser with pre-installed extensions"
docker exec -i "${DB_CONTAINER}" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
CREATE ROLE fieldloop_migrator LOGIN PASSWORD 'migrator' CREATEROLE;
CREATE DATABASE fieldloop_restricted OWNER fieldloop_migrator;
\connect fieldloop_restricted
CREATE EXTENSION postgis;
CREATE EXTENSION vector;
SQL
docker run --rm --network "${NETWORK}" \
  -e DATABASE_URL="postgres://fieldloop_migrator:migrator@${DB_CONTAINER}:5432/fieldloop_restricted?sslmode=disable" \
  "${MIGRATE_IMAGE}" up

echo "Migration tests passed"
