# Scenario catalog

Put authored `.json`, `.yaml` or `.yml` Scenarios here (FL-75 owns the two demo storylines).
The simulator validates every file at startup; an invalid file prevents startup. The catalog
is copied into its image. `FIELDLOOP_SCENARIO_DIR` selects another installed catalog locally.
The player does not accept filesystem paths or arbitrary Scenario uploads from the browser.

The canonical format is `packages/contracts/scenario.v1.schema.json`. Events are ordered by
`atSeconds`; equal times retain file order. Event IDs and bookmark IDs must be unique. Noise
is an absolute, uniform amplitude on numeric values, seeded by Scenario version and event ID.
`target` names an Asset, Barrier or source. The emitted payload carries that target, `SIMULATION`
and `sandbox: true`. An event changes no Barrier Health directly.

Historian events use the installed DL-01 tags and their exact units. They set the read-only
historian's override from the event time onwards. Other sources publish their declared
observation through `signal.v1`; source-specific read models can hydrate from the pinned
Scenario and committed event index. Those integrations belong to their source issues.

Use the publisher's source ID in each event. Installed Demo B sources use `mock-hydro`
tags `rain.rate`, `rain.accumulation.24h`, `water.level` and `tide.level`, and `mock-pumps`
tags `pump.power` and `gate.power`. Hydro payloads name `assetCode`, `zone` and `kind`;
pump/gate payloads name `assetCode`, `facilityType`, `zone` and `operatingState`.
Keep the Facility in `target` and payload even when multiple Facilities share a tag.
The flood pack's rainfall rule consumes 24-hour accumulation in `mm`, not the instantaneous
rate in `mm/h`. The authored storm uses a fixed rate so its accumulation can be computed
exactly with `SimulatedHydro.rain_accumulation`; only canal levels have seeded noise.

Controls use the server clock. Forward bookmark jumps emit intervening events. An earlier bookmark restores the baseline,
opens a new run and replays up to that point; pause before jumping. Reset preserves seed and speed, creates a new
run ID, restores the baseline atomically and retires the previous run. Values and observation
times replay identically; new IDs keep consumer deduplication from suppressing a fresh run.

Seed the demo before its first run. Its initial active Action Request, notification and Health
Proposal sets must be empty. Reset retains their run history, human Approvals and audit rows;
active readers use `app.current_*` views. Every simulation consumer must set the transaction's
`app.simulation_run_id` to the incoming Signal's `simulationRunId` and call
`app.assert_simulation_run(id, org_id)` before effects. The database refuses a retired epoch,
missing epoch while a run is active, cross-Organisation writes and a non-sandbox notification.

The service is private in Cloud Run and trusts invoker IAM. Only the BFF has invocation access;
it verifies the cookie session, CSRF, Operator/Manager permission, Organisation and clearance.
Local mode accepts loopback callers only. No outbound notification sender exists in the player.
State and command results are persisted in PostgreSQL; retries retain their response for 24 h.
Playback advances while requests/SSE polling are active, which holds request-scoped Cloud Run
CPU without a permanent warm instance. When clients reconnect after a gap, the server catches
up from its persisted anchor. A publication timeout rolls back state; a retry uses identical
Signal IDs, so consumers must deduplicate deliveries.

## Authored demo Scenarios (FL-75)

All values below are simulated. Both start at `2026-10-12T00:00:00Z`, matching the seed fixtures.
Use seed **75** for the rehearsal; seed is required by `POST /v1/simulation/runs`, not a field
in a Scenario file. Selecting another seed changes only the optional canal-level noise.

| Scenario | Key bookmarks and observations | Duration / classification |
| --- | --- | --- |
| `cp-rectifier-failure` | `rectifier-failure` (T+10m, output 0 A); `encroachment` (T+30m, two existing synthetic patrol GPS findings); `cp-evidence-overdue` (T+24h+1s); `outage-over-24h` (T+24h+10m+1s); `complete` | 48 h / HIGHLY_RESTRICTED |
| `bangkok-storm` | `start` (72 mm/h rain in Z3); `pump-power-lost` (P-3 loses power at T+20m); `heavy-rainfall` (T+2h, 144 mm accumulated and rain stops); `forecast-24h`; `complete` (+72h) | 72 h / CONFIDENTIAL |

### Baseline and source references

- Load the DL-01 and Bangkok seeds before running against a deployed database. The CP Barrier's
  newest performance Evidence is `cp-survey-2025` at `2025-10-13T00:00:00Z` with a 12-month
  interval. Its matching CMMS work order `SYN-CMMS-001` is due at `2026-10-13T00:00:00Z`.
  The overdue observation is one second after that boundary; no fresh survey is fabricated.
- The two encroachment events announce `SYN-PATROL-001` and `SYN-PATROL-004`, already in the
  read-only patrol source. `foundAt` remains the earlier source timestamp; `observedAt` is
  when the Scenario announces the finding. Platform ingestion owns snapping GPS to Chainage.
- Bowtie D's `dual-power-generators` Barrier on P-3 is already **Degraded**. Its latest test is
  `dual-power-generators-check-2` from `2026-09-01`, with a one-month interval (due `2026-10-01`).
  `generatorTest` on P-3's payload references this seeded overdue condition; it is context,
  not a new CMMS work order or a command that changes Health.
- The storm's 72 mm/h over two hours gives 144 mm in the trailing 24-hour window. It falls to
  zero at T+26h. The authored accumulation events use the installed `rain.accumulation.24h`
  tag and pass the flood pack's `>100 mm` condition. Actual proposals are downstream work.

### Test before merge or deployment

From the repository root, with the locked dependencies installed:

```bash
uv run --locked --all-packages pytest apps/simulator/tests/test_demo_scenarios.py -q
bash scripts/test-simulation.sh
```

The first command loads the real YAML files through the validator and validating Signal
publisher. It checks the Evidence/source references, P-3 just before and at T+20m, rainfall
integration, seed/noise, 1x versus 60x, Step versus Play, Reset and all SIMULATION/sandbox flags.
The second uses disposable PostgreSQL to check cold starts and durable reset/replay of both
files. These run in the existing Python and database CI jobs; neither needs cloud credentials.

For a presenter check once the local stack or a deployment is configured: sign in as an
Operator/Manager with sufficient clearance, select a Scenario, enter seed 75, and create a
run. Step or pause and jump to the bookmarks above, inspect emitted Signals, then Reset and
repeat with the same seed. The run IDs must change while observation values/times stay equal.
The Docker image copies and validates this catalog at startup.

Scope of this verification: Scenario loading, Signal emission and player persistence. The
current player hydrates the historian HTTP read model; Demo B hydro/pump HTTP read models are
not yet hydrated from the player's committed event index. Read emitted Signals to verify the
storm/outage. Health/Risk projections, map overlays and sandbox notification delivery require
their downstream integrations and a separate end-to-end check.
