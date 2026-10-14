# Guardrail Tier 1 latency probe

This k6 probe measures the end-to-end latency of `POST /guardrail/v1/content:scan`
and fails when p95 reaches 50 ms. It also checks that requests succeed and return
the same benign synthetic content. Each iteration uses a new idempotency key and
creates normal Intercept and Evidence records.

Run it from an approved runner inside the project VPC, with permission to invoke
the private Guardrail service. Set `GUARDRAIL_URL` to the demo service origin,
`GUARDRAIL_ID_TOKEN` to a Google-signed identity token whose audience is that
origin, and `GUARDRAIL_AI_SYSTEM` to the registered demo AI System code.

```sh
k6 run apps/guardrail/performance/tier1-content-scan.js
```

The default run sends 100 requests with one virtual user. Set `K6_VUS` and
`K6_ITERATIONS` to run a different load. This endpoint measurement includes
Cloud Run ingress, Cloud SQL persistence, Model Armor and client network time; it
is not an isolated in-process detector benchmark. No live latency result is
claimed until the probe runs against a deployed service.
