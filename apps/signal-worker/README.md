# Signal worker (FL-76)

`POST /internal/pubsub/signals` authenticates the Google-signed service token,
checks the subscription and publisher attributes, and validates the canonical
`signal.v1` message. Signature, issuer, expiry and audience verification use the
Google adapter; the push email must be verified and match the configured service
account. See [Google's authenticated push guidance](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions).

The worker reads the registered JSONB rules written by FL-78. It resolves the
pack/Bowtie/Barrier selectors using generic content codes, Organisation, simulation
provenance and Bowtie paths. Seed reloads populate `bowtie.code` and `barrier.code`.
Optional `assetId` and `barrierId` further restrict the targets. A spatial rule
requires `payload.location` as a GeoJSON Point with valid longitude/latitude;
the point must be covered by the registered Polygon, including its boundary.

Each qualifying observation becomes Evidence; matching rules create **open Health
Proposals**. A Signal never applies the proposed Health. Numeric thresholds do not
coerce strings or missing values. Categorical string thresholds use exact `eq`
matching with the exact unit. Boolean status rules accept booleans as 0/1 only
with the `boolean` unit. `windowSeconds` describes an aggregate already reported
by the source, such as rain accumulated over 24 hours. An explicit
`durationSeconds` requires successive observations with no missing expected
samples; the history budget is 10,000 readings and duration is at most seven days.
Duration histories are isolated by source/tag, Asset, Barrier, unit, simulation
provenance and Scenario run. Calendar inspections cannot prove a continuous duration.

### Upstream source contract alignment

The independent source samples are pinned to [FL-72 PR #47 head `2a99d85`](https://github.com/Kaotor-Technology/FieldLoop-v2/pull/47) in the shared `test/fixtures/pr47-signals.json` fixture. It publishes rain rate as `mock-hydro` / `rain.rate` / `mm/h`, plus a separate 24-hour aggregate as `rain.accumulation.24h` / `mm` with `windowSeconds=86400`; the latter matches the rainfall rule in [FL-78 PR #44](https://github.com/Kaotor-Technology/FieldLoop-v2/pull/44). Pump power is `mock-pumps` / `pump.power` / `lost` / `state`, which also matches the pack rule. The worker does not sum the rain rate again. Unit and PostGIS integration tests consume the same independent fixture, which remains separate from `signal-cases.json`; they verify the aggregate and pump readings create Evidence and Health Proposals while the rate alone does not. CP and patrol use their periodic rules and three-calendar-month silence interval as configured above.

## Periodic measurements and silence

CP and patrol are measured every **three calendar months**, per the owner's
instruction on 2026-10-13. They are periodic inspections. Configure the source
intervals explicitly:

```sh
FIELDLOOP_SOURCE_INTERVALS='{"mock-historian":{"months":3},"mock-patrol":{"months":3},"mock-hydro":60,"mock-pumps":60}'
```

Hydro/pump seconds here are authored **simulation settings**, not measured
operator standards. A registered rule can override a source interval with either
`expectedIntervalSeconds` or `expectedIntervalMonths`, except when that source
is configured with a calendar interval: configured months are authoritative and
the rule cannot add a continuous duration. Restart the worker after changing
registered rules or interval configuration. Month arithmetic uses
`FIELDLOOP_MEASUREMENT_TIME_ZONE` (default `Asia/Bangkok`), including month-end
clamping. It does not substitute 90 days for three months.

`POST /internal/jobs/silent-sources` requires the separate Scheduler identity.
When the receipt-clock deadline is strictly exceeded, dependent Healthy/Degraded
Barriers become Unverified with a Health Change, append-only audit record and
`barrier.health_changed` event. Failed stays Failed. A new measurement never
restores Health automatically. Dependencies start their first interval at worker
registration even when the source has never been heard. Old observations and
redelivery do not refresh liveness. Scenario run IDs isolate replay watermarks;
silence uses service receipt time so Scenario clock jumps cannot instantly silence
every source. Evidence ageing and human acceptance/rejection belong to FL-82.

## Persistence and delivery

Signal, producer receipt, Evidence, Proposal and outbox rows commit in one database
transaction. The producer UUID is the deduplication key, scoped to the Organisation;
a different Pub/Sub message ID does not create another Proposal. Reusing a producer
ID with different content returns 409. Out-of-order observations remain history
and Evidence, and do not raise stale Proposals.

Outbox delivery is **at least once**. The stable event UUID survives retries and
consumers must deduplicate it. A failed publish keeps events pending and returns
503 to Pub/Sub. Each invocation drains up to 100 pending events; both Signal pushes
and the source-check job retry the outbox. Invalid messages remain unacknowledged
for the existing subscription's dead-letter policy. Event bodies contain IDs and
provenance; restricted Signal payloads are excluded from events and request-error logs.
Classification is the highest of the Signal, rule and Barrier.

## Configuration and release

- `DATABASE_URL`, or the existing `FIELDLOOP_DB_CONNECTION_NAME`,
  `FIELDLOOP_DB_NAME`, `FIELDLOOP_DB_USER` Cloud SQL IAM settings.
- `FIELDLOOP_DEFAULT_ORG_ID`, `FIELDLOOP_ENV`, explicit `SIMULATED=true|false`.
  The demo requires `SIMULATED=true`.
- `GOOGLE_CLOUD_PROJECT`, `FIELDLOOP_WORKER_AUDIENCE`,
  `FIELDLOOP_PUBSUB_PUSH_EMAIL`, `FIELDLOOP_SCHEDULER_EMAIL`,
  `FIELDLOOP_SIGNAL_SUBSCRIPTION`, `FIELDLOOP_SOURCE_INTERVALS`.
- Optional `FIELDLOOP_DOMAIN_EVENT_TOPIC` (default `domain-events`) and calendar
  timezone setting above.

Configured deployments fail startup on missing settings, absent registered rules,
unresolved selectors or database failure. A container without database configuration
provides `/healthz` for scaffold smoke checks; its internal work routes return 503.
Terraform supplies private VPC access, instance-scoped SQL IAM, domain-event
publisher IAM and one pinned custom audience shared with Pub/Sub/Scheduler.

Release prerequisites: provision the worker IAM SQL users; run the migration;
reload DL-01/Bangkok seeds with content codes; register the FL-78 packs; release
the worker image; verify authenticated push/events; then enable the new paused
hourly `silent-sources` Scheduler jobs. Existing ageing/SLA jobs remain paused.
The worker DB role cannot read BFF session tokens or modify audit records.
No GCP configuration was applied by this feature's local tests.

## Verification

```sh
pnpm --filter @fieldloop/signal-worker test
pnpm test:signals
bash scripts/test-migrations.sh
```

`test:signals` needs Docker and uses a disposable PostgreSQL 16 with PostGIS and
pgvector, both synthetic seeds and the current validated pack rules loaded through
the FL-78 API pack loader. It checks scoped worker grants, concurrent deduplication,
rollback, periodic CP/patrol, the registered aggregate-rain and categorical-pump rules, duration
boundaries, spatial coverage, quarterly Bangkok dates, silence/audit and outbox
retry. It separately ingests the pinned PR #47 rain/pump source samples and verifies
that unmatched data cannot create false Evidence or Proposals. It also prints local
latency and an `EXPLAIN (ANALYZE, BUFFERS)` history query. These results do not
establish Cloud Run latency, billing, browser SSE or end-to-end GCP delivery.
