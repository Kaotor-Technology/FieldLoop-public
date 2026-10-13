# Mock source systems (FL-71, FL-72)

Read-only stand-ins for the Demo A and Demo B source systems of PRD SIM-2,
served by the simulator under `/mock/` (architecture §4.2).

## Rules every source follows

- **Read-only.** Each path serves `GET` only. Every other method, `POST`, `PUT`,
  `PATCH`, `DELETE` and the rest, returns `405` with `Allow: GET` and
  `application/problem+json`. A path with a trailing slash is first redirected
  (`307`) to its canonical form, so a write there is refused on the second
  request. Nothing a request carries changes what a later read returns.
- **Synthetic and labelled.** Every response carries `label: SYNTHETIC`
  (`SIMULATION` for the Demo B storm sources), `simulated: true` and a
  `classification` (PRD §9.1). Values are illustrative,
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
  With a database configured, a `/mock/` read first rehydrates the sources from
  the Scenario player's committed run; if that fails the answer is `503`
  `service_unavailable`.
- **Strict queries.** A query parameter the route does not declare, a
  parameter given twice, a boolean that is not exactly `true` or `false`, and a
  timestamp with more than six fractional digits are each `400`. A misspelt
  filter is therefore refused and never answered with unfiltered data
  (`known_query_only`, `QueryBoolean` and `Rfc3339` in `mock_http.py`).
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

## Mock CMMS (FL-142)

`GET /mock/cmms/work-orders?pmDue=<boolean>&asOf=<RFC 3339>`

Four authored work orders for DL-01, in ID order. Both parameters are optional,
and the list is small and bounded, so it is not paginated.

| Work order | Barrier (`barrierId`) | Kind | Status | Due (UTC) | Completed (UTC) |
| --- | --- | --- | --- | --- | --- |
| `SYN-CMMS-001` | `cathodic-protection` | `preventive` | `open` | 2026-10-13 00:00 | |
| `SYN-CMMS-002` | `remote-automatic-valve-closure` | `preventive` | `open` | 2027-09-15 00:00 | |
| `SYN-CMMS-003` | `coating` | `corrective` | `open` | 2026-12-15 00:00 | |
| `SYN-CMMS-004` | `depth-of-cover-and-markers` | `preventive` | `completed` | 2026-09-15 00:00 | 2026-09-15 00:00 |

- **PM due.** `pmDue` is `true` or `false`. `pmDue=true` returns only the open
  preventive work orders with `dueAt` at or before `asOf`. Corrective and
  completed work is left out. Without it, all four are returned.
- **`asOf` is Scenario time, not the wall clock.** It is timezone-aware RFC 3339
  with the same rules as the historian's `from` and `to`; anything else is
  `400`. When omitted it is `2026-10-12T00:00:00Z`, the `simulationStartsAt` of
  the DL-01 Bowtie, so a bare read is reproducible (SIM-5). The response reports
  `asOf` in UTC.
- **Where the dates come from.** A preventive work order is due when its
  Barrier's newest Evidence in the Bowtie file is one 12-month evidence
  interval old: 2025-10-13 for cathodic protection, 2026-09-15 for valve
  closure. The completed survey is that Barrier's newest Evidence (2026-09-15)
  and was due a year after the one before. The corrective repair has no
  interval; its date is authored to fall after the simulation.
- **One thing changes during a run.** At the start of the simulation
  `pmDue=true` returns nothing. From `2026-10-13T00:00:00Z` it returns
  `SYN-CMMS-001`, the cathodic protection survey, which is the moment of PRD
  Demo A step 5. Nothing else falls due before 2026-12-15, so no other work
  order competes with the demo script.
- **Barrier reference.** `barrierId` is the ID of a Barrier in
  `data/synthetic/dl-01/bowtie-a.json`. A real CMMS knows equipment and
  maintenance plans, not Barriers; the mock carries the mapping so a consumer
  need not parse titles. A work order has no Chainage: the synthetic data has
  no location for a rectifier, and none is invented here. The simulator image
  does not contain `data/`, so the values are literals and a test keeps the
  Barrier IDs, the default `asOf` and the preventive dates in step with the
  Bowtie file.
- **Completion.** `completedAt` is present exactly when `status` is
  `completed`, and is absent, not null, otherwise. The schema enforces both.
  A read or an observation at a time before `completedAt` shows the work order
  as it was then: `open`, with no `completedAt`.
- **Organisation.** Each work order carries the Organisation in
  `FIELDLOOP_ORG_ID`, as the historian and the patrol app do.
- **Classification** is `INTERNAL`, lower than the historian (`CONFIDENTIAL`)
  and the patrol app and ILI report (`HIGHLY_RESTRICTED`). The owner confirmed
  the value on 2026-10-13.
- **Work orders arrive as Signals.** PRD §8.1 lists the CMMS as a Demo A Signal
  source, and the owner confirmed on 2026-10-13 that it publishes.
  `SimulatedCmms.observe(work_order_id, at)` returns the Observation for
  `SimulatedSignalEmitter`, naming its own `source` and `classification`:

  | Member | Value |
  | --- | --- |
  | `source`, `classification` | `mock-cmms`, `INTERNAL` |
  | `tag` | `DL-01.<barrierId>.work_order.overdue`, for example `DL-01.cathodic-protection.work_order.overdue` |
  | `value`, `unit` | `1` while the work order is open and `dueAt` is at or before `at`; `0` before that and once it is completed; `boolean` |
  | `observedAt` | the Scenario time `at` |
  | `payload` | the work order: `assetCode`, `workOrderId`, `barrierId`, `kind`, `status`, `title`, `dueAt`, `completedAt` when completed, `label` |

  For a preventive work order the flag turning to `1` is its PM due date
  arriving; `kind` in the payload tells preventive from corrective. The tag
  names the Barrier, as a historian tag names its instrument, so a Signal rule
  (source, tag, `eq 1`, unit) can match one Barrier's work without reading the
  payload. The work order is the subject of the Signal's identity, so two work
  orders on one Barrier stay distinct and a replay keeps its ID. No pack rule
  matches these tags yet, so the Signal is stored as Evidence. A read cannot
  publish: the module holds no publisher, and only `observe()` builds a Signal.

  ```python
  cmms = app.state.cmms
  await emitter.emit(cmms.observe("SYN-CMMS-001", scenario_time), run_id=run_id)
  ```
- **No Scenario state.** The CMMS has no override and no reset: a read and an
  observation depend only on their arguments and the configured Organisation. A
  Scenario moves PM due by the time it reads or observes at, not by changing
  the source.
- **No write.** The simulator holds `SimulatedCmms` in `app.state.cmms` and has
  no operation that creates, closes or changes a work order. Work in a real
  CMMS is prepared as an Action Request (ADR-0006), never sent from here.

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
source is a Signal by the glossary's definition, as a patrol finding is. The owner chose this on 2026-10-13 (FL-144).

### Deployment prerequisite

The bucket, the object and `FIELDLOOP_ILI_DROP_BUCKET` come from the Terraform
change, which is **not applied**; nothing here has run against real storage.

## Demo B sources (FL-72)

Rain, canal level, tide and pump/gate status for the Bangkok storm Scenario
(PRD §8.1 Demo B). They follow every rule above with two differences: the label
is `SIMULATION`, because the storm is simulated, and there is no seed. No live
public API is called (PRD Q49).

Both sources share these points:

- **`asOf` is Scenario time, not the wall clock.** It is optional,
  timezone-aware RFC 3339 with the same rules as the CMMS `asOf`; anything else
  is `400`. When omitted it is `2026-10-12T00:00:00Z`, the `simulationStartsAt`
  of `data/synthetic/bangkok/bowtie-d.json`. The response reports it in UTC as
  `observedAt`.
- **Facilities come from the Bangkok data.** Sensor, pump and gate codes and
  their zones are the Facilities of `data/synthetic/bangkok/facilities.geojson`.
  The simulator image does not contain `data/`, so they are literals and a test
  keeps them in step. A response carries no coordinates.
- **Classification** is `CONFIDENTIAL`, as the historian's readings are and as
  the `signal.v1` example cases for these two sources state. The Facility
  positions are `HIGHLY_RESTRICTED` in the seed and are not served here.
- **Signal names come from the contract.** Source, tag and value are those of
  the "flood observation" and "pump power lost" cases in
  `packages/contracts/test/fixtures/signal-cases.json`, and a test holds each
  source's Signal to its case. A flood pack rule matches a tag exactly, so the
  tag carries no Facility code: the payload's `assetCode` names the Facility.
  In a Signal that a source's `observe()` builds, the Facility also takes part
  in the Signal `id`, so two pumps at one instant stay distinct.
- **In a run, the Scenario player drives both sources (FL-309).** A Scenario
  event names the source, its tag, its unit and the target Asset. The player
  publishes the Signal, and the service replays every applied event into the
  source, so a read of `/mock/hydro/…` or `/mock/pumps/…` follows the run and
  returns to its baseline on reset. It does so on every command, on every
  read of the run, and before a `/mock/` read after a cold start.
  - **One payload.** The player takes a Demo B Signal's payload from the
    source (`signal_payload` in each module) and adds its own envelope:
    `target` and `sandbox: true`. An author writes no Asset code, zone or
    operating state; anything else an author puts in `payload` is kept.
  - **One publisher.** In a run only the player publishes, and the Scenario
    event is the Signal's identity. `observe()` on a source builds the same
    Signal for a caller in process, such as a test or an operator's script,
    with the Facility as its identity. A test holds the two to one source,
    tag, value, unit, classification and payload.
  - **Validated at load.** The Scenario validator refuses an event that the
    source could not publish, at the member that is wrong: an unknown tag, a
    unit or target Asset that is not the source's, a rain rate that its noise
    could take below zero, a power status other than `available` or `lost`
    (`storm_events.py`).
  - **A run pinned earlier keeps its events.** A run stores the Scenario it was
    created with. If such a run holds an event that these rules now refuse, the
    player still publishes it and the source's reads leave it out.
- **Scenario state is per process**, as the historian's overrides are, and is
  dropped by `reset()` and by scale-to-zero.
- **No Barrier reference.** A Signal names its Facility, not a Barrier of
  Bowtie D. The flood pack rule chooses the Barriers (`pump-power-lost`
  proposes `pumping-stations`).

### Mock hydrology (FL-145)

`GET /mock/hydro/{kind}?asOf=<RFC 3339>` returns one reading.

| Kind | Sensor | Zone | Unit | Baseline | Signal tag |
| --- | --- | --- | --- | --- | --- |
| `rain` | `S-R1` | `Z3` | `mm/h` | 0 | `rain.rate` |
| `level` | `S-L1` | `Z3` | `m` | 0.6 | `water.level` |
| `tide` | `S-T1` | `Z4` | `m` | 0.3 to 1.5, a 12 hour triangle wave | `tide.level` |

- Any other kind is `404`. The baselines are authored simulation values, not
  measurements or forecasts of a real place, and levels have no stated datum.
  The schema ties `unit` to `kind` and refuses a rain rate below zero.
- The body is `kind`, `assetCode` (the sensor), `zoneCode`, `value`, `unit`, `observedAt`,
  `orgId`, `label`, `simulated` and `classification`.
- A Scenario event sets a reading: `tag: rain.rate`, `value: 60`,
  `unit: mm/h`, `target: {kind: asset, id: S-R1}`. A caller in process does
  the same by hand:

  ```python
  hydro = app.state.hydro
  # T+0: a rain cell enters zone Z3 at 60 mm/h and stays until the run is reset.
  hydro.add_override("rain", start=scenario_time, value=60.0)
  await emitter.emit(hydro.observe("rain", scenario_time), run_id=run_id)
  ```

  `add_override(kind, start, value)` holds a kind at `value` from `start` on.
  The latest `start` wins; among equal starts the override added last does.
  `reset()` forgets every override. A rain rate below zero is refused; a level
  may be negative, because it is relative to a datum.
- The Signal is `source: mock-hydro`, the tag above, the reading as `value`,
  its `unit`, `observedAt` at the Scenario time, and
  `payload: {assetCode, zone, kind, label}`.
- **Rainfall over 24 hours.** `observe_rain_accumulation(at)` gives a second
  Signal for the rain sensor: `tag: rain.accumulation.24h`, `unit: mm`, and the
  rainfall of the 24 hours of Scenario time that end at `at`, with
  `payload: {assetCode, zone, kind, windowSeconds, label}`. The rate is flat
  between overrides, so nothing is sampled. It is what the flood pack rule
  `rainfall-needs-fresh-evidence` matches (`mock-hydro`,
  `rain.accumulation.24h`, above 100 mm), and a test holds the two together.
  A storm held at 60 mm/h crosses the rule after 1 hour 40 minutes. The HTTP
  API does not serve the sum; it is a Signal only. The rule also carries
  `windowSeconds: 86400`: the value is already the 24 hour sum, so the worker
  that evaluates the rule (FL-76) must not sum it over that window again.
  In a Scenario the event has `tag: rain.accumulation.24h`, `unit: mm`,
  `target: {kind: asset, id: S-R1}` and `value: null`: the player sums the rain
  rates that the run published before the event, seeded noise included, so no
  author states a total. The Signal exists only at the times a Scenario has
  such an event.

  ```python
  await emitter.emit(hydro.observe_rain_accumulation(scenario_time), run_id=run_id)
  ```

### Mock pump and gate status (FL-146)

`GET /mock/pumps/{id}/status?asOf=<RFC 3339>` returns the status of one Facility.

| Facility | Type | Zone | State with power |
| --- | --- | --- | --- |
| `P-1` | pump | `Z3` | `running` |
| `P-2` | pump | `Z4` | `running` |
| `P-3` | pump | `Z3` | `running` |
| `G-1` | gate | `Z3` | `closed` |
| `G-2` | gate | `Z4` | `closed` |

- Any other id is `404`. The body is `assetCode`, `facilityType`, `zoneCode`,
  `operatingState`, `powerStatus` (`available` or `lost`), `observedAt`,
  `orgId`, `label`, `simulated` and `classification`. `operatingState` is
  `running` or `stopped` for a pump and `open` or `closed` for a gate; the
  schema enforces the pairing.
- **Power lost.** A Scenario event changes power: `tag: pump.power`,
  `value: lost`, `unit: state`, `target: {kind: asset, id: P-3}`. That is the
  only thing it changes. A pump without power is `stopped`; a gate stays where it was.

  ```python
  pumps = app.state.pumps
  # T+20m: pump P-3 loses power.
  pumps.set_power("P-3", start=scenario_time, status="lost")
  await emitter.emit(pumps.observe("P-3", scenario_time), run_id=run_id)
  ```

  `set_power(id, start, status)` holds from `start` on, with the same
  precedence as a hydrology override, so `status="available"` at a later start
  restores power. `reset()` forgets every change.
- The Signal is `source: mock-pumps`, `tag: pump.power` (`gate.power` for a
  gate), `value: lost` or `available`, `unit: state`, and
  `payload: {assetCode, facilityType, zone, operatingState, label}`. For a pump
  that is exactly what the flood pack rule `pump-power-lost` matches, and a
  test holds the two together.
- **No command.** There is no operation that starts, stops, opens or closes a
  Facility. Operating a real pump or gate is an L1 Command Package (ADR-0006),
  never sent from here.

## Verifying a deployment (operator)

Nothing in this change is applied, so none of this is automated. Run it as the human
infrastructure operator, in this order, and record the results in `docs/contexts/FL-71.md`.

1. **Plan and apply from `main`, not from a feature branch.** A branch that is behind `main`
   plans to destroy resources that `main` added. For each environment the FL-71 part of the
   plan is: create the `ili_drop` bucket and the `ili_report` object, create two
   `simulator_signal_publisher` grants (`signals` and `dead_letter`), and update
   `app["simulator-<env>"]` (three new variables, at most one instance). Nothing else may
   mention the simulator. Run it from the checkout that has `local.auto.tfvars`: the four maps
   that own the jobs live only there, and a plan without them also deletes the seed jobs and
   strips `DATABASE_URL` from the migration jobs (which happened on 2026-10-13 and failed the
   release). Read the plan for any destroy before applying.
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

- **The sources are on the app.** `app.state.historian`, `app.state.cmms`, `app.state.patrol`, `app.state.ili`,
  `app.state.hydro` and `app.state.pumps` are the objects that the routes read. `tests/test_scenario_contract.py` is the executable form of
  what a caller in process may rely on: every source is on the app, a read follows an override, a read
  never publishes, a replay keeps its Signal ID, and a Signal is not labelled below its
  source's classification. The override and replay cases use the historian; the hydrology and pump
  sources test their own Scenario state, and the classification case covers all six sources.
- **State is per process.** Overrides, pump and gate power changes and the run's seed live in the instance, so Terraform caps
  the service at one instance.
- **Reset every source.** `historian.reset()`, `hydro.reset()` and `pumps.reset()` are separate calls. The
  service resets all three and replays the applied events of the committed run on every command and read.
- **An idle instance forgets.** The service has `min_instance_count = 0` and request-based CPU
  (`cpu_idle = true`; `cpu-throttling: true` on the live service). Scale-to-zero drops the
  overrides and the seed, and CPU is throttled between requests, so a player that advances
  Scenario time from a background timer is not reliable. FL-74 must either advance time from
  requests it receives, or hold one warm instance with CPU always allocated for the demo window,
  which has a cost against the US$100 budget and needs a deliberate Terraform change.
