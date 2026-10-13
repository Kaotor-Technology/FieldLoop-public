#!/usr/bin/env bash
# Isolated PostgreSQL integration and measured retrieval latency; no GCP calls.
set -euo pipefail
cd "$(dirname "$0")/.."
knowledge_container="fieldloop-knowledge-test-$$"
trap 'docker rm -f "$knowledge_container" >/dev/null 2>&1 || true' EXIT
docker build -q -t fieldloop-db-test:pg16 - < db/test/Dockerfile
docker run --rm -d --name "$knowledge_container" -e POSTGRES_PASSWORD=fixture \
  -e POSTGRES_DB=knowledge_fixture -p 127.0.0.1::5432 fieldloop-db-test:pg16 >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$knowledge_container" pg_isready -q -h 127.0.0.1 -U postgres; then break; fi
  sleep 1
done
docker exec "$knowledge_container" pg_isready -q -h 127.0.0.1 -U postgres
knowledge_port="$(docker port "$knowledge_container" 5432/tcp | sed 's/.*://')"
export FIELDLOOP_KNOWLEDGE_TEST_DSN="postgres://postgres:fixture@127.0.0.1:${knowledge_port}/knowledge_fixture"
uv run --locked --all-packages pytest apps/assistant/integration -v -s
