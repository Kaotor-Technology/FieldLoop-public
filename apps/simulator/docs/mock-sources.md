# Demo A mock source systems (FL-71)

Read-only stand-ins for the Demo A source systems of PRD SIM-2, served by the
simulator under `/mock/` (architecture §4.2). The mock CMMS belongs to FL-142 and
is documented with that change.

## Rules every source follows

- **Read-only.** Each path serves `GET` only. Every other method, `POST`, `PUT`,
  `PATCH`, `DELETE` and the rest, returns `405` with `Allow: GET` and
  `application/problem+json`. A path with a trailing slash is first redirected
  (`307`) to its canonical form, so a write there is refused on the second
  request. Nothing a request carries changes what a later read returns.
- **Synthetic and labelled.** Every response carries `label: SYNTHETIC`,
  `simulated: true` and a `classification` (PRD §9.1). Values are illustrative,
  not operating figures of any real asset.
- **Deterministic.** No wall clock and no randomness: a response is a function
  of the request, the fixed seed and any Scenario override, so a fixed seed
  reproduces a run (SIM-5).
- **Internal.** These routes are not part of the web-api/BFF. In dev and demo
  they sit behind Cloud Run invoker IAM; the handlers do not authenticate
  callers themselves.
- **Errors** under `/mock/` are RFC 9457 problem details using the shared
  `ErrorCode` values: `validation_failed` (400), `not_found` (404, including an
  unknown path) and `method_not_allowed` (405). Request values are never echoed.
  The handlers are installed on the app (`install_problem_handlers`), so any
  route added under `/mock/` gets them; paths elsewhere keep FastAPI's defaults.
- **A contract each.** `mock-<source>.v1.openapi.json` and
  `mock-<source>.v1.schema.json` in `packages/contracts` describe a source. The
  response models are generated from the schema, `pnpm lint:api` lints the
  OpenAPI file with `.spectral.mock.yaml`, and a test fails when a `/mock/` route
  has no contract or a contract has no route. A new source is those two files,
  its router and its tests ([contracts README](../../../packages/contracts/README.md#mock-source-contracts-fl-71)).
- **Signals, not pushes.** A source reaches the platform only as `signal.v1`
  messages on the `signals` topic, published in process by the Scenario player
  (SIM-3). There is no HTTP trigger because the APIs are read-only.
- **What a Signal is.** The glossary defines it as Evidence that arrives
  automatically from a connected source system. That says nothing about the
  content: a measurement (a historian tag), a status (a pump) and a report (a
  patrol finding, an ILI report arriving) are all Signals. A Signal is stored as
  Evidence and may trigger a Signal rule, which creates a Health Proposal; it
  never changes Barrier Health by itself (LS-3).

## Mock historian (FL-141)

`GET /mock/historian/tags/{tag}?from=<RFC 3339>&to=<RFC 3339>`

| Tag | Unit | Synthetic band |
| --- | --- | --- |
| `DL-01.pressure.line` | `bar` | 60.4 to 63.6 |
| `DL-01.flow.line` | `m3/h` | 1135 to 1265 |
| `DL-01.rectifier.output` | `A` | 11.55 to 12.45 |

- `from` and `to` are required, timezone-aware RFC 3339 (lowercase `t`/`z`
  accepted, numeric epochs and naive times rejected). A timestamp whose UTC
  instant falls outside years 1 to 9999 is rejected too. `to` must be after
  `from` and at most 24 hours later; otherwise `400`. An unknown tag is `404`.
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
# T+0: the rectifier output drops to zero and stays there until the run is reset.
historian.add_override("DL-01.rectifier.output", start=scenario_time, value=0.0)

publisher = signal_publisher_from_environment(os.environ)  # when a run starts
emitter = SimulatedSignalEmitter(publisher, org_id=historian.org_id)
await emitter.emit(historian.observe("DL-01.rectifier.output", scenario_time), run_id=run_id)
```

- `add_override(tag, start, value)` holds a tag at `value` from `start` on. The
  latest `start` wins; among equal starts the override added last does.
  `reset(seed=None)` forgets every override and, given a seed, takes the next
  run's seed (SIM-5). The seed is otherwise the default `DEMO_SEED`.
- **One process.** Overrides are state of the running process, and so is
  everything a Scenario player will hold. Terraform therefore caps the
  `simulator` service at one instance; a second instance would answer reads
  without the override. If the player ever needs more, its state has to move to a
  shared store first.
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
on is set by the publisher configuration and is not enforced by IAM. [Verifying a deployment](#verifying-a-deployment-operator) lists the checks.

### Tests

```sh
uv run --locked --all-packages pytest apps/simulator/tests -q
uv run --locked --all-packages python scripts/generate_mock_source.py historian  # regenerate the model
```

`scripts/test_mock_signals.py` exercises the real SDK against a loopback
Pub/Sub emulator (delivery, replay, quarantine); CI runs it in the "Signal
publishers on Pub/Sub emulator" job.

## Mock patrol app (FL-143)

`GET /mock/patrol/findings`

Five authored right-of-way findings for DL-01, oldest first, each with a GPS fix.
`kind` is `encroachment`, `marker_damage` or `erosion`. The endpoint takes no
parameters, as architecture §4.2 lists it, and the list is small and bounded, so
it is not paginated.

| Finding | Kind | Severity | Status | Observed (UTC) | Intended Chainage |
| --- | --- | --- | --- | --- | --- |
| `SYN-PATROL-005` | `marker_damage` | low | closed | 2026-10-09 08:00 | 23 100 m |
| `SYN-PATROL-001` | `encroachment` | high | open | 2026-10-11 02:15 | 38 400 m |
| `SYN-PATROL-002` | `marker_damage` | low | open | 2026-10-11 03:05 | 61 700 m |
| `SYN-PATROL-003` | `erosion` | medium | open | 2026-10-11 04:40 | 104 900 m |
| `SYN-PATROL-004` | `encroachment` | medium | open | 2026-10-11 06:20 | 142 300 m |

- **GPS, not Chainage.** A finding carries `gps: {latitude, longitude,
  accuracyM}` as a device would report it. The fixes lie 1.6 to 9.3 m beside
  the route, so snapping to Chainage (GEO-9) has something to do. The Chainage column
  is where each fix was authored to land; the API does not return it.
- **Derived from the route.** The coordinates come from
  `data/synthetic/dl-01/route.geojson`. The simulator image does not contain
  `data/`, so they are literals in the module and a test recomputes the route to
  keep every fix within 20 m of it and within 50 m of its intended Chainage.
- **Classification.** Findings are `HIGHLY_RESTRICTED` because a run of GPS
  fixes along the pipeline reveals Asset geometry (PRD 9.1). This is more
  conservative than the `CONFIDENTIAL` Evidence rows of the DL-01 seed.
- **Findings arrive as Signals.** `SimulatedPatrol.observe(finding_id, at)`
  returns the Observation for `SimulatedSignalEmitter`. It names its own
  `source` (`mock-patrol`) and `classification` (`HIGHLY_RESTRICTED`, as the API
  reports), so one emitter serves every source and cannot mislabel a Signal:

  | Member | Value |
  | --- | --- |
  | `tag` | `DL-01.<kind>.detected`, for example `DL-01.encroachment.detected` |
  | `value`, `unit` | `1` while the finding is open, `0` once it is closed; `boolean` |
  | `observedAt` | the Scenario time `at` |
  | `payload` | the report: `findingId`, `kind`, `severity`, `status`, `summary`, `foundAt` (when the patroller found it), `gps`, `label` |

  The encroachment Signal is the shape FL-78's `encroachment-detected` rule
  matches (`mock-patrol`, `DL-01.encroachment.detected`, `eq 1`, unit
  `boolean`). The finding is the subject of the Signal's identity, so two
  findings of one kind at one instant stay distinct and a replay keeps its ID.
- **No photographs yet.** A patrol report also carries images in the owner's
  description; none are modelled. Doing so needs a contract field, synthetic
  image files and a place to serve them.

## Mock ILI report drop (FL-144)

`GET /mock/ili/reports/{id}` serves one synthetic in-line inspection report,
`SYN-ILI-2026-001`, run on 2026-08-24 and issued 2026-09-10 by the fictional
"Synthetic Inspection Services". An unknown id is `404`.

| Anomaly | Chainage | Clock | Feature | Depth (% wall) |
| --- | --- | --- | --- | --- |
| `A-001` | 12 800 m | 04:30 | external metal loss | 12 |
| `A-002` | 38 250 m | 06:00 | external metal loss | 27 |
| `A-003` | 61 400 m | 11:15 | internal metal loss | 9 |
| `A-004` | 87 600 m | 03:45 | external metal loss | 18 |
| `A-005` | 104 700 m | 07:20 | external metal loss | 31 |
| `A-006` | 133 900 m | 09:10 | internal metal loss | 15 |

- **One document, two homes.** The JSON file in
  `apps/simulator/src/fieldloop_simulator/fixtures/ili/` is the API response,
  returned as its own bytes, and the object that Terraform creates in each
  environment's `ili-drop` bucket (`reports/SYN-ILI-2026-001.json`). The
  simulator itself neither reads nor writes the bucket, so it holds no storage
  permission, and nothing is granted on the bucket yet: the ingestion consumer
  that reads the object (FL-76) is the one to receive that grant.
- **Where the file lives.** The fixture sits beside the module that serves it,
  not in `data/synthetic/`, because the simulator image does not contain `data/`.
- **No Organisation inside the file.** A vendor's report does not know FieldLoop
  Organisation IDs; the drop location identifies the Organisation.
- **Classification** is `HIGHLY_RESTRICTED`: inspection raw data (PRD 9.1).
- **Format.** A real vendor delivers PDF or spreadsheet files. This one is JSON so
  it is machine-checkable; documents for the assistant's extraction path (PRD
  Demo A step 2) belong to the synthetic corpus, not to this source.

### Announcing the arrival

A Scenario turns the drop into a Signal with the same emitter as the historian:

```python
drop = app.state.ili  # SimulatedIliDrop, bucket from FIELDLOOP_ILI_DROP_BUCKET
await emitter.emit(drop.observe("SYN-ILI-2026-001", scenario_time), run_id=run_id)
```

The Signal is `source: mock-ili`, `tag: DL-01.ili.report.received`, `value: 1`,
`unit: boolean`, with a payload of `assetCode`, `reportId`, `bucket`,
`objectName`, `contentType`, `anomalyCount` and `label`. The payload locates the
file and does not copy the findings. The `bucket` member is absent when
`FIELDLOOP_ILI_DROP_BUCKET` is unset, as it is locally.

**Why a Signal and not a bucket notification.** A Cloud Storage notification
publishes the raw object event, which is not `signal.v1`; sent to `signals` it
would be quarantined, and no other topic has a consumer for it yet. The Signal
travels the validated path that SIM-3 requires and a rule can match it later
without infrastructure change. A bucket notification is an additive follow-up
once an ingestion consumer exists. A report file that arrives from a connected
source is a Signal by the glossary's definition, as a patrol finding is.

### Deployment prerequisite

The bucket, the object and `FIELDLOOP_ILI_DROP_BUCKET` come from the Terraform
change, which is **not applied**; nothing here has run against real storage.

## Verifying a deployment (operator)

Nothing in this change is applied, so none of this is automated. Run it as the human
infrastructure operator, in this order, and record the results in `docs/contexts/FL-71.md`.

1. **Plan and apply from `main`, not from a feature branch.** A branch that is behind `main`
   plans to destroy resources that `main` added. For each environment the FL-71 part of the
   plan is: create the `ili_drop` bucket and the `ili_report` object, create two
   `simulator_signal_publisher` grants (`signals` and `dead_letter`), and update
   `app["simulator-<env>"]` (three new variables, at most one instance). Nothing else may
   mention the simulator. On 2026-10-13 a plan of this branch against the live project showed
   exactly that and was not applied.
2. **The report is in the bucket**, byte for byte what the API serves, and the bucket is private:

   ```sh
   P=example-project; ENV=dev
   gcloud storage cat "gs://$P-fieldloop-$ENV-ili-drop/reports/SYN-ILI-2026-001.json" | shasum -a 256
   shasum -a 256 apps/simulator/src/fieldloop_simulator/fixtures/ili/SYN-ILI-2026-001.json   # same digest
   gcloud storage buckets describe "gs://$P-fieldloop-$ENV-ili-drop" \
     --format='value(public_access_prevention,uniform_bucket_level_access,location)'   # enforced True ASIA-SOUTHEAST1
   ```

3. **The grant exists** on both topics, for this environment's simulator only:

   ```sh
   gcloud pubsub topics get-iam-policy signals --project=$P --format=json
   gcloud pubsub topics get-iam-policy fieldloop-v2-dead-letter --project=$P --format=json
   # roles/pubsub.publisher: serviceAccount:fl-v2-simulator-$ENV@$P.iam.gserviceaccount.com
   ```

4. **The release replaced the image.** Until it has, the service answers `/mock/*` with
   FastAPI's 404. A `run.app` URL answers `/healthz` from Google's front end (404, HTML), as the
   README notes, so probe a `/mock/` path. The caller needs `roles/run.invoker`:

   ```sh
   URL="$(gcloud run services describe simulator-$ENV --project=$P --region=asia-southeast1 --format='value(status.url)')"
   TOKEN="$(gcloud auth print-identity-token)"
   curl -s -H "Authorization: Bearer $TOKEN" "$URL/mock/ili/reports/SYN-ILI-2026-001" | shasum -a 256   # same digest
   curl -s -o /dev/null -w '%{http_code} %{content_type}\n' -X POST -H "Authorization: Bearer $TOKEN" "$URL/mock/patrol/findings"   # 405 application/problem+json
   ```

5. **A Signal reaches the topic.** No HTTP trigger exists, so publish one by hand as the
   simulator's own identity (the operator needs `roles/iam.serviceAccountTokenCreator` on it).
   This prints a `gcloud` command whose body and attributes are exactly what the publisher sends:

   ```sh
   uv run --locked --all-packages python - <<'PY'
   import asyncio, shlex
   from datetime import UTC, datetime
   from fieldloop_common.memory_transport import InMemoryTransport
   from fieldloop_common.signal_publisher import SignalPublisher
   from fieldloop_simulator.mock_historian import SimulatedHistorian
   from fieldloop_simulator.mock_signals import SimulatedSignalEmitter

   ENV, PROJECT, ORG = "dev", "example-project", "fieldloop-demo"
   transport = InMemoryTransport()
   publisher = SignalPublisher(transport, environment=ENV, org_id=ORG, simulation_only=True)
   historian, at = SimulatedHistorian(), datetime.now(UTC).replace(microsecond=0)
   historian.add_override("DL-01.rectifier.output", start=at, value=0.0)
   asyncio.run(SimulatedSignalEmitter(publisher, org_id=ORG).emit(historian.observe("DL-01.rectifier.output", at)))
   ((topic, data, attributes),) = transport.messages
   print("gcloud pubsub topics publish", topic, f"--project={PROJECT}",
         f"--impersonate-service-account=fl-v2-simulator-{ENV}@{PROJECT}.iam.gserviceaccount.com",
         "--attribute=" + shlex.quote(",".join(f"{k}={v}" for k, v in attributes.items())),
         "--message=" + shlex.quote(data.decode()))
   PY
   ```

   Run the printed command. A `PERMISSION_DENIED` before the apply is the expected proof that the
   grant is absent. After it, the signal worker has no `/internal/pubsub/signals` handler until
   FL-76, so the push is refused and retried five times, and the message lands in the dead-letter
   review subscription after a few minutes. That is the expected result, and it shows the grant,
   the `environment` filter and the push attempt together:

   ```sh
   gcloud pubsub subscriptions pull fieldloop-v2-dead-letter-review --project=$P --limit=5 --format=json
   ```

## What the Scenario player must account for (FL-74)

- **The sources are on the app.** `app.state.historian`, `app.state.patrol` and `app.state.ili` are
  the objects that the routes read. `tests/test_scenario_contract.py` is the executable form of
  what a player may rely on: a read follows an override, a read never publishes, a replay keeps
  its Signal ID, and a Signal is not labelled below its source's classification.
- **State is per process.** Overrides and the run's seed live in the instance, so Terraform caps
  the service at one instance.
- **An idle instance forgets.** The service has `min_instance_count = 0` and request-based CPU
  (`cpu_idle = true`; `cpu-throttling: true` on the live service). Scale-to-zero drops the
  overrides and the seed, and CPU is throttled between requests, so a player that advances
  Scenario time from a background timer is not reliable. FL-74 must either advance time from
  requests it receives, or hold one warm instance with CPU always allocated for the demo window,
  which has a cost against the US$100 budget and needs a deliberate Terraform change.
