# Bangkok seed loader (FL-69 / FL-138)

Run after the dbmate migrations. Data/provenance and offline regeneration are in
[the dataset README](../../../data/synthetic/bangkok/README.md).

```sh
FIELDLOOP_ORG_ID=fieldloop-demo FIELDLOOP_DATABASE_URL='<postgres-url>' \
  pnpm db:seed:bangkok
FIELDLOOP_ORG_ID=fieldloop-demo node db/seed/bangkok/seed.mjs --print-sql
docker build -f db/seed/bangkok/Dockerfile -t seed-bangkok .
```

The URL and Organisation must be explicit; no default target exists. `--print-sql`
prints bound SQL and parameters without connecting. The image runs as `node`,
reads saved OSM snapshots offline and writes no generated files at runtime.

One transaction loads 178 Assets (2 Area, 168 Linear, 8 Facility), Bowtie D,
its two zone-scope links, four Threats, four Consequences, 15 Barriers,
one Independence Group, 23 path placements, four Degradation Factors/Controls,
30 Evidence rows and 30 Geo References. It reads counts and valid PostGIS
geometry back before committing. Every domain row is `simulated=true`:
Assets/Geo References are `HIGHLY_RESTRICTED`, Bowtie records and Evidence
`CONFIDENTIAL`, and the shared Organisation is `INTERNAL`, following FL-305.
The real public geometry retains its OSM provenance in Asset attributes.

IDs are stable per Organisation. Reruns serialize with a transaction advisory
lock and reset this seed's rows to the authored initial state. Cleanup only
removes rows with this Organisation and `created_by=seed:bangkok` whose IDs are
absent from the current seed, children first. Foreign references block cleanup
and roll back the load. DL-01 and other creators' rows stay outside that cleanup.
Both seeds use the accepted shared Organisation UUID and row values.

Use reruns only to initialize/reset seed data in a controlled environment.
Scenario reset, risk calculations, Signal rules and outbound actions belong to
their feature issues. No Risk Snapshot, approval or notification is authored here.
Barrier owner roles are placeholders in the JSON; binding `owner_id` to real
persona accounts is downstream integration work.

## Verification and cloud handoff

`pnpm test:seed:bangkok` runs an isolated PostgreSQL 16/PostGIS/pgvector database,
migrations, late-error rollback, two identical loads, spatial/path assertions,
seed ownership cleanup, stale foreign-reference rollback, two Organisations,
DL-01 coexistence and image runtime checks. It requires Docker.

Terraform's `bangkok_seed_images` configures on-demand `db-seed-bangkok-<env>` jobs
with digest-pinned images and environment-specific migration identities; do not
extract the migration secret to a workstation. The trusted release publishes
`v2-db-seed-bangkok:<release-sha>` and reports its digest; it never runs either seed.
Follow [the operator workflow](../../../infra/terraform/README.md#bangkok-seed-job-fl-22)
and keep load evidence in [FL-22's context](../../../docs/contexts/FL-22.md).
The local image tests use a Docker internal network with no public API egress
and verify corruption rejection, initial Health, scope links and rerun stability.
