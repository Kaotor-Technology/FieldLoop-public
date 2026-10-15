#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm exec turbo run build --filter=@fieldloop/api... --filter=@fieldloop/guardrail...
TASK_CONTAINER="fieldloop-actions-test-$$"
TASK_DB_IMAGE="fieldloop-db-test:pg16"
cleanup() { docker rm -f "${TASK_CONTAINER}" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker build -q -t "${TASK_DB_IMAGE}" - < db/test/Dockerfile
docker run -d --name "${TASK_CONTAINER}" --tmpfs /var/lib/postgresql/data:rw,size=256m -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=fieldloop_test -p 127.0.0.1::5432 "${TASK_DB_IMAGE}" >/dev/null
for _ in $(seq 1 60); do
  if docker exec "${TASK_CONTAINER}" pg_isready -q -h 127.0.0.1 -U postgres; then break; fi
  if [ "$(docker inspect "${TASK_CONTAINER}" --format '{{.State.Running}}')" != "true" ]; then docker logs "${TASK_CONTAINER}"; exit 1; fi
  sleep 1
done
docker exec "${TASK_CONTAINER}" pg_isready -q -h 127.0.0.1 -U postgres
TASK_PORT="$(docker port "${TASK_CONTAINER}" 5432/tcp | sed 's/.*://')"
TASK_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${TASK_PORT}/fieldloop_test?sslmode=disable"
DATABASE_URL="${TASK_DATABASE_URL}" pnpm db:migrate
FIELDLOOP_ACTION_TEST_DATABASE_URL="${TASK_DATABASE_URL}" pnpm --filter @fieldloop/api exec vitest run test/action-service.integration.test.ts
