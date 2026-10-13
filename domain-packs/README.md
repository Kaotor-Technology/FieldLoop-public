# Demo Domain Packs (FL-78)

`pipeline-integrity` and `flood-water` are independently versioned, authored
simulation content. Their thresholds are illustrative; they are not engineering
limits, forecasts or official warning criteria. Gen AI Safety belongs to FL-85.

Each `pack.yaml` carries Threat Categories, Knowledge Library folders, declarative
Signal rules, Agent YAML file references and warning templates. Contracts live in
`packages/contracts/domain-pack.v1.schema.json` and
`agent-definition.v1.schema.json`; `pnpm --filter @fieldloop/contracts generate`
generates their types. `golden.json` fixes each demo catalog's expected rules and
proposed outcomes. Golden tests also check selectors against the existing seeds.

`web-api` loads both required packs before opening a listener. Set
`FIELDLOOP_DOMAIN_PACKS_DIR` to override the bundled directory. Malformed YAML,
schema errors, unknown tool names, invalid handoffs, duplicate IDs, unknown folders
and warning-placeholder mismatches stop startup with a source filename. Files may
not escape their pack directory through symlinks. Definitions are available in
`app.domainPacks` for downstream catalog integration. The tool vocabulary is
validated against architecture §7.3; this catalog grants no execution permission.
The assistant runtime still has to implement tools and enforce the Guardrail,
user permissions and runtime limits (FL-87/FL-88).

With `FIELDLOOP_DEFAULT_ORG_ID` and either `DATABASE_URL` or the existing Cloud SQL
connection settings, startup registers Threat Categories and Signal rules in one
transaction through the existing database pool. IDs are deterministic per
Organisation/pack/entity/code, so restarting updates records without duplicates.
Registration works even when BFF credentials are not yet configured. Without
database configuration the catalog is loaded in memory and startup logs
`persisted: false`; it is not a persisted deployment.

Rules use `targetBarrierSelector` with pack, Bowtie code and Barrier codes from the
DL-01 and Bangkok seeds. Database `signal_rule.condition` stores the condition
plus `ruleId`, `packVersion` and `effect`; `spatialGeometry`, when present, becomes
`signal_rule.spatial_geom` (SRID 4326). No domain-specific core columns are added.
Signal `gt`/`lt` thresholds are numeric; `eq` thresholds can match numeric, string
or boolean Signal values. The pump outage rule matches the shared fixture's
categorical `pump.power = "lost"` status.
Rule evaluation, resolving selectors to seeded rows and creating Health Proposals
belong to FL-76. Every effect is a proposal; loading packs never changes Health.
Evidence ageing in this initial pack also requests human review; an automatic
Unverified ageing policy, if used by the worker, must follow BM-3.

Warning templates have identical declared placeholders in English and Thai,
including `district`, a SIMULATION label, L2 and `approvalRequired: true`. Rendering
and sandbox delivery belong to the Action Request workflow; this loader sends no
notifications. Agent AI System codes `demo-uc-1` and `demo-uc-4` are configuration
identifiers to bind to the later AI System register, not database UUIDs.

Version 1 supports idempotent reloads and updates of retained rule codes. Removing
or renaming a published rule needs an explicit retirement policy before an upgrade;
registration does not delete rows referenced by historical Health Proposals.

Validation:

```bash
pnpm --filter @fieldloop/contracts test
pnpm --filter @fieldloop/adapters test
pnpm --filter @fieldloop/api test
pnpm test:domain-packs
```

The last command needs Docker and tests PostGIS persistence, repeated loads,
Organisation isolation, transaction rollback and unchanged Barrier Health.
