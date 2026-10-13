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

Use the publisher's source ID in each event. The current Demo B sources in
[PR #47](https://github.com/Kaotor-Technology/FieldLoop-v2/pull/47) at
[`ebaf194`](https://github.com/Kaotor-Technology/FieldLoop-v2/tree/ebaf194f0d52c5437c45d471424ab17001bb1cb6)
use `mock-hydro` tags `rain.rate`, `water.level` and `tide.level`, and `mock-pumps` tags
`pump.power` and `gate.power`. Hydro Signals carry `assetCode`, `zone`, `kind` and `label`;
pump/gate Signals carry `assetCode`, `facilityType`, `zone`, `operatingState` and `label`.
Keep the Facility in `target` and payload even when multiple Facilities share a tag. The PR
body says `signal-cases.json` is unchanged from `main`; these source tags and payload shapes
are taken from the source observations in PR #47, not inferred from a test editing those cases.
The PR also records that `rainfall-needs-fresh-evidence` expects `rain.accumulation.24h` while
the source publishes `rain.rate` only; the 24-hour aggregation remains unresolved (FL-24, FL-76).
Get FL-73/FL-24 owner sign-off on the rule mapping and aggregation before authoring Signal rules.

Controls use the server clock. Forward bookmark jumps emit intervening events; to return to
an earlier bookmark, reset and jump forward. Reset preserves seed and speed, creates a new
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
