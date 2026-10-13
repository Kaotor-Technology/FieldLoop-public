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

Demo B events use the installed `mock-hydro` and `mock-pumps` tags, units and Assets, and the
validator refuses anything else at the member that is wrong
([mock sources](../../apps/simulator/docs/mock-sources.md#demo-b-sources-fl-72)):

| Source | `tag` | `value` | `unit` | `target` (kind `asset`) |
| --- | --- | --- | --- | --- |
| `mock-hydro` | `rain.rate` | number, not below 0 after noise | `mm/h` | `S-R1` |
| `mock-hydro` | `water.level` | number | `m` | `S-L1` |
| `mock-hydro` | `tide.level` | number | `m` | `S-T1` |
| `mock-hydro` | `rain.accumulation.24h` | `null` | `mm` | `S-R1` |
| `mock-pumps` | `pump.power` | `available` or `lost` | `state` | `P-1`, `P-2` or `P-3` |
| `mock-pumps` | `gate.power` | `available` or `lost` | `state` | `G-1` or `G-2` |

Write no `payload` for these events: the source states the Asset code, zone and operating
state, and the player adds `target` and `sandbox`. A read of the source follows the applied
events, as of the run's clock when the caller names no `asOf`, whatever `startsAt` is. `rain.accumulation.24h` is derived: the player sums the `rain.rate` events before it
over 24 hours, so place one where the run should report the total. It is what the Flood pack
rule `rainfall-needs-fresh-evidence` matches (above 100 mm); at 60 mm/h that is 1 hour
40 minutes after the rain starts. `pump.power` with `lost` is what `pump-power-lost` matches.
PRD §8.1 has the storm trigger its rule before the pump fails, so a storyline with P-3 losing
power at T+20m needs a higher rate, an earlier start of the rain, or the rainfall rule to fire
second. Without a `rain.accumulation.24h` event a run never publishes the total.

```yaml
- {id: rain-starts, atSeconds: 0, source: mock-hydro, target: {kind: asset, id: S-R1},
   tag: rain.rate, value: 60, unit: mm/h}
- {id: pump-loses-power, atSeconds: 1200, source: mock-pumps, target: {kind: asset, id: P-3},
   tag: pump.power, value: lost, unit: state}
- {id: rainfall-after-2h, atSeconds: 7200, source: mock-hydro, target: {kind: asset, id: S-R1},
   tag: rain.accumulation.24h, value: null, unit: mm}
```

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
