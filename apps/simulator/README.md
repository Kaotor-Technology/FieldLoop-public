# Mock CMMS (FL-142)

The simulator serves `GET /mock/cmms/work-orders`, the internal endpoint in
`docs/architecture.md` §4.2. Four fixed synthetic work orders represent DL-01
preventive and corrective work, including one completed preventive order.
Every response and item explicitly carries `SYNTHETIC`, `simulated: true` and
`classification: INTERNAL`. The fixture Organisation is `fieldloop-demo`.
These are authored fixture values, not observations of any customer or live CMMS.

## Query semantics

- `pmDue=true` selects only **open preventive** work with `dueAt <= asOf`.
  Completed and corrective work are excluded. Without it, all four records return.
- `asOf` is a timezone-aware RFC 3339 simulation timestamp. The omitted default
  is fixed at `2026-10-10T00:00:00Z`, not wall time. Invalid dates, naive timestamps
  and numeric epoch strings return 400 `application/problem+json`.
- POST/PUT/PATCH/DELETE/TRACE/CONNECT return 405, `Allow: GET`, and Problem JSON.
  Reads do not mutate fixtures or publish anything.

The bounded four-item internal fixture list is deliberately separate from the
public paginated BFF platform list API. No browser route, UI or real connector
was added. Caller-selected Organisation/asset scopes, arbitrary fixture upload,
Scenario state mutation and Signal publishing are not part of this subtask.
FL-141 owns historian publishing; the remaining FL-71 subtasks own other sources.

## Contracts and generated models

- `packages/contracts/mock-cmms.v1.openapi.json` documents the internal API,
  query fields and errors; `/mock/` is the architecture's internal simulator
  namespace, not a new `/v1/` BFF route. The existing `openapi.yaml` remains the
  web-api contract and its shared Problem schema is referenced for errors.
- `packages/contracts/mock-cmms.v1.schema.json` is the canonical wire response.
- `py/fieldloop_common/src/fieldloop_common/generated_mock_cmms.py` is generated:
  do not edit it by hand.

Regenerate with:

```sh
uv run --locked --all-packages python scripts/generate-mock-cmms.py
```

The drift regression generates into a temporary path with the same pinned
code generator and repository Ruff configuration, then compares exact bytes.
The suite also validates real handler responses against the canonical JSON Schema.

## Local execution

```sh
uv sync --locked --all-packages
uv run --locked --package fieldloop-simulator uvicorn fieldloop_simulator.main:app --host 127.0.0.1 --port 19142
```

Read `/healthz`, `/mock/cmms/work-orders` and
`/mock/cmms/work-orders?pmDue=true`. The local process has no network clients,
source-write capability, publisher, database access or credentials.

In dev/demo this is part of the existing simulator image/service, not a newly
provisioned standalone Cloud Run service. Runtime isolation must remain behind
Cloud Run invoker IAM. The handler does not verify proxy headers or browser
identity and must not be exposed publicly. No deployment/IAM change was made.
Actual cloud rollout/invoker checks are a post-merge operator gate, not implied
by local tests or an image build.

## Tests

```sh
uv run --locked --all-packages pytest apps/simulator/tests -q
uv run --locked --all-packages ruff check .
uv run --locked --all-packages mypy
```

Tests cover deterministic reads, PM due boundary/timezone semantics, write
rejection without mutation, invalid queries, synthetic provenance, canonical
response validation, generated-model drift and the internal OpenAPI contract.
