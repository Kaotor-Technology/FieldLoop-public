#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Building API workspace dependencies"
pnpm exec turbo run build --filter=@fieldloop/api...

SUFFIX="$$"
DB_CONTAINER="fieldloop-risk-integration-${SUFFIX}"
DB_IMAGE="fieldloop-db-test:pg16"
DATABASE_NAME="fieldloop_risk_test"

cleanup() {
  docker rm -f "${DB_CONTAINER}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Building PostgreSQL 16 test image"
docker build -q -t "${DB_IMAGE}" - < db/test/Dockerfile

echo "==> Starting disposable PostgreSQL"
docker run -d --name "${DB_CONTAINER}" \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB="${DATABASE_NAME}" \
  -p 127.0.0.1::5432 "${DB_IMAGE}" >/dev/null
for _ in $(seq 1 60); do
  if docker exec "${DB_CONTAINER}" pg_isready -q -h 127.0.0.1 -U postgres; then break; fi
  sleep 1
done
docker exec "${DB_CONTAINER}" pg_isready -q -h 127.0.0.1 -U postgres

HOST_PORT="$(docker port "${DB_CONTAINER}" 5432/tcp | sed 's/.*://')"
DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${HOST_PORT}/${DATABASE_NAME}?sslmode=disable"

echo "==> Applying all migrations"
DATABASE_URL="${DATABASE_URL}" pnpm db:migrate

echo "==> Running RiskService PostgreSQL integration tests"
FIELDLOOP_RISK_TEST_DATABASE_URL="${DATABASE_URL}" \
FIELDLOOP_IMPORT_TEST_DATABASE_URL="${DATABASE_URL}" \
  pnpm --filter @fieldloop/api exec vitest run test/risk-service.integration.test.ts test/import-store.integration.test.ts test/import-dl01-acceptance.integration.test.ts
