# Demo A mock source systems (FL-71)

Read-only stand-ins for the Demo A source systems of PRD SIM-2, served by the
simulator under `/mock/` (architecture §4.2). The mock CMMS belongs to FL-142 and
is documented with that change.

## Rules every source follows

- **Read-only.** Each path answers `GET`; every other method returns `405` with
  `Allow: GET` and `application/problem+json`. Nothing a request carries changes
  what a later read returns.
- **Synthetic and labelled.** Every response carries `label: SYNTHETIC`,
  `simulated: true` and a `classification` (PRD §9.1). Values are illustrative,
  not operating figures of any real asset.
- **Deterministic.** No wall clock and no randomness: a response is a function
  of the request, the fixed seed and any Scenario override, so a fixed seed
  reproduces a run (SIM-5).
- **Internal.** These routes are not part of the web-api/BFF. In dev and demo
  they sit behind Cloud Run invoker IAM; the handlers do not authenticate
  callers themselves.
- **Errors** are RFC 9457 problem details using the shared `ErrorCode` values
  (`validation_failed`, `not_found`); request values are never echoed. The
  shared enum has no method-specific code, so a `405` also uses
  `validation_failed`.
- **Signals, not pushes.** A source reaches the platform only as `signal.v1`
  messages on the `signals` topic, published in process by the Scenario player
  (SIM-3). There is no HTTP trigger because the APIs are read-only.

## Mock historian (FL-141)

`GET /mock/historian/tags/{tag}?from=<RFC 3339>&to=<RFC 3339>`

| Tag | Unit | Synthetic band |
| --- | --- | --- |
| `DL-01.pressure.line` | `bar` | 60.4 to 63.6 |
| `DL-01.flow.line` | `m3/h` | 1135 to 1265 |
| `DL-01.rectifier.output` | `A` | 11.55 to 12.45 |

- `from` and `to` are required, timezone-aware RFC 3339 (lowercase `t`/`z`
  accepted, numeric epochs and naive times rejected). `to` must be after `from`
  and at most 24 hours later; otherwise `400`. An unknown tag is `404`.
- Samples sit on a **60 second UTC clock grid**, inclusive of both ends, not on
  the requested start. A window therefore has at most 1441 points.
- The series is a daily triangle wave plus hash-derived jitter. It avoids
  transcendental functions so values are identical on every platform. The
  default seed is pinned by a test.

### What a Scenario does

The simulator app holds one `SimulatedHistorian` in `app.state.historian`.
The Scenario player (FL-74) changes it and publishes from the same process:

```python
historian = app.state.historian
# T+0: the rectifier output drops to zero until cleared.
historian.add_override("DL-01.rectifier.output", start=scenario_time, value=0.0)

publisher = signal_publisher_from_environment(os.environ)  # when a run starts
emitter = SimulatedSignalEmitter(
    publisher, org_id=historian.org_id, source="mock-historian", classification="CONFIDENTIAL"
)
await emitter.emit(historian.observe("DL-01.rectifier.output", scenario_time), run_id=run_id)
```

- `add_override(tag, start, value, end=None)` holds a tag at `value` from `start`
  (inclusive) to `end` (exclusive). The latest `start` wins. `clear_overrides()`
  is the reset hook (SIM-5).
- The emitted Signal is `source: mock-historian`, `tag`, finite `value`, `unit`,
  `observedAt` in UTC, `simulated: true`, `classification: CONFIDENTIAL`, an
  optional `simulationRunId`, and `payload: {assetCode, label, quality}`. A
  rectifier output of `0` with unit `A` is the shape the pipeline pack rule
  `cp-rectifier-output-lost` matches (FL-78).
- The Signal `id` is a UUIDv5 of Organisation, run, source, tag, time and value,
  so replaying a run keeps identities and consumers can deduplicate. `0` and
  `0.0` share one identity. Delivery is at least once.
- The publisher is simulation-only. A real-labelled observation or an
  Organisation mismatch is quarantined on the dead-letter topic with restricted
  metadata and is never sent to `signals`.

### Configuration

| Variable | Meaning | Default |
| --- | --- | --- |
| `FIELDLOOP_ENV` | `dev`, `demo` or `local`; sets the `environment` attribute | `local` |
| `FIELDLOOP_ORG_ID` | Organisation of the series and the Signals | `fieldloop-demo` |
| `GOOGLE_CLOUD_PROJECT` | Project for the Pub/Sub client; required to publish | none |

The Pub/Sub client is built when `signal_publisher_from_environment` is called,
not at import, so the service starts and answers reads without credentials.

### Deployment prerequisite

Terraform grants each environment's simulator identity
`roles/pubsub.publisher` on `signals` and on the dead-letter topic, and sets the
two variables above. **That change is not applied**; an operator must plan and
apply it before the simulator can publish in dev or demo. The grants are
topic-wide, so the `environment` attribute that the signal subscriptions filter
on is set by the publisher configuration and is not enforced by IAM.

### Tests

```sh
uv run --locked --all-packages pytest apps/simulator/tests -q
uv run --locked --all-packages python scripts/generate-mock-source.py historian  # regenerate the model
```

`scripts/test-mock-signals.py` exercises the real SDK against a loopback
Pub/Sub emulator (delivery, replay, quarantine); CI runs it in the "Signal
publishers on Pub/Sub emulator" job.
