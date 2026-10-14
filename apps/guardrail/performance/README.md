# Guardrail Tier 1 latency probe

This k6 probe measures the end-to-end latency of `POST /guardrail/v1/content:scan`
and fails when p95 reaches 50 ms. It also checks that requests succeed and return
the same benign synthetic content. Each iteration uses a new idempotency key and
creates normal Intercept and Evidence records.

Run it from an approved runner inside the project VPC, with permission to invoke
the private Guardrail service. Set `GUARDRAIL_URL` to the demo service origin,
`GUARDRAIL_ID_TOKEN` to a Google-signed identity token whose audience is that
origin, `GUARDRAIL_INTERNAL_USER_TOKEN` to a five-minute RS256 token minted by
`web-api` for a synthetic demo user, and `GUARDRAIL_AI_SYSTEM` to the registered
demo AI System code. Keep both tokens in the approved runner's secret store; do
not put them in source control or browser storage.

```sh
docker run --rm \
  --volume "$PWD/apps/guardrail/performance:/scripts:ro" \
  --env GUARDRAIL_URL \
  --env GUARDRAIL_ID_TOKEN \
  --env GUARDRAIL_INTERNAL_USER_TOKEN \
  --env GUARDRAIL_AI_SYSTEM \
  --env K6_VUS \
  --env K6_ITERATIONS \
  grafana/k6:2.3.0@sha256:9c2dee7f8ed74d317e4027c06a10f169b625638189de8d4555d0b3486a5aeb34 \
  run /scripts/tier1-content-scan.js
```

The container pins k6 v2.3.0 by image digest. Run it on the
approved runner so the container uses that host's network route to the private
service. Export the four required `GUARDRAIL_*` variables and, optionally, the
two `K6_*` variables from the runner's approved secret/configuration store
before starting Docker. Do not pass token values as command-line arguments or
write them into the repository.

The default run sends 100 requests with one virtual user. Set `K6_VUS` and
`K6_ITERATIONS` to run a different load. This endpoint measurement includes
Cloud Run ingress, Cloud SQL persistence, Model Armor and client network time; it
is not an isolated in-process detector benchmark. No live latency result is
claimed until the probe runs against a deployed service.
