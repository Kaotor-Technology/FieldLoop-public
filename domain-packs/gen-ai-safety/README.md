# Gen AI Safety demo pack (FL-85)

This versioned SIMULATION pack registers the UC-1 assistant line-up as one
`AI System` (`demo-uc-1`). The six Agent definitions stay in `pipeline-integrity`;
startup validates their names, Use Case, system identity and tool vocabulary.
`pack.yaml` declares the catalog; `ai-safety.yaml` carries the system, policies
and the PRD §6.1-C Bowtie C. `gen-ai-safety.v1.schema.json` generates shared types.

| Policy | Detector capability | Technical Barrier | Configuration |
| --- | --- | --- | --- |
| `injection-detector` | `model-armor` | `injection-detector` | Scan input/retrieved content; block findings |
| `restricted-data-routing` | `sensitive-data-protection` | `classification-routing` | All four data classes use private hosting; missing eligible route blocks |
| `output-dlp` | `sensitive-data-protection` | `output-dlp` | Redact output; unsafe redaction blocks |
| `system-of-record-tool-block` | `tool-target-policy` | `tool-call-policy` | Block direct SCADA/CMMS/GIS/Asset database writes; prepare L1 Action Requests |

All four policies are Tier 1, `enforce`, `fail-closed`. Detector names identify
capabilities for FL-86 to implement; loading this configuration does not scan
content, call a model, emit Intercepts or execute a tool. Guardrail startup loads
and validates the policies before listening. FL-86 supplies gateway enforcement
and Intercept Evidence; FL-87 supplies guarded tool execution and Action Requests.

Consequence severity uses the shared RiskSeverity vocabulary (`legalRegulatory: 5`
for restricted-data disclosure, `people: 4` for wrong engineering decisions).
The contract enforces the AS-4 Human/Organisational PFD ceiling of 0.1 and pins the
demo Bowtie identity to `uc-1-bowtie-c`, so a renamed parent cannot bypass review.

The default model route is private Flash-class; a private Pro-class route is
available for long report Drafts. Public SaaS is disabled. Confidential and Highly
Restricted data require a private in-country boundary without retention or
training (ADR-0002). Hosting tiers are distinct from detector tiers.

Bowtie C includes four Threats, two Consequences (severity 5 and 4), all twelve
preventive/mitigative Barriers, paths, the three Degradation Factors/Controls and
a shared-gateway Independence Group. It starts as a Draft; every Barrier starts
Unverified. PFD bands use the labelled AS-4 demo defaults, with no invented
Threat frequencies, conditional probabilities or operational Evidence. Tier 2
grounding is explicitly deferred. The Cross-Domain reference to Bowtie B's
Phishing/pivot Threat remains `template-only`: Cyber/OT is outside the demo slice,
so no dangling or invented database target is created.

## Registration

`web-api` requires all three demo packs before listening. With
`FIELDLOOP_DEFAULT_ORG_ID` and the existing local/database connection settings,
startup seeds Threat Categories, Bowtie C, its graph, `ai_system` and
`guardrail_policy` in the existing catalog transaction. IDs are stable and scoped
to Organisation/pack/entity/code. Each policy's `config` records its authored ID,
version, detector settings, AI System code, model routes and Bowtie ID/code;
`barrier_id` and `ai_system_id` are actual foreign keys. No migration is required.

Reloading a Draft updates retained authored definitions while preserving Barrier
Health and owner. The seed locks the parent Bowtie inside the catalog transaction.
Every policy records `config.seedDefinitionHash`, computed from canonical authored
pack/safety data (object-key order is ignored). Once the Bowtie leaves Draft,
identical seed content leaves the whole graph, AI System, policy records and
reviewed local overrides untouched. The human-reviewed Bowtie revision is independent
of the authored pack version; an unchanged seed preserves either revision.
Changed authored content or pack version, renamed policies,
missing proof or incompatible proof aborts the transaction. Concurrent human
review cannot be overwritten by startup registration.

Existing reviewed registrations from older code without that hash fail closed;
they require an explicit human-reviewed migration. This task does not implement
a review/migration UI or silently adopt legacy proof. A code rollback retains
historical rows. Registration never creates Evidence, Intercepts, approvals or
Health changes. Renaming/removing published IDs or changing graph
membership needs a retirement/migration design; this seed does not delete
historical records. Without database settings, the catalog is validated in
memory and startup reports `persisted: false`.

## Reviewer checks

Use Node 22.23.3, pnpm 10.34.6 and Docker as documented in the repository README:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:domain-packs
pnpm lint:api
pnpm check:safety
```

The contract/adapter/Guardrail suites reject unknown detectors, fail-open,
monitor-only, missing policies, incompatible policy Barriers, broken graph paths,
unsafe routes and an incompatible Agent line-up. The disposable PostGIS test
runs migrations and seeds under the application role, validating persisted
severity against the shared contract. It checks counts and
foreign keys, SIMULATION/classification, idempotency, version updates, preserved
Health, reviewed states/local overrides, changed-definition rejection, concurrent
human review, legacy proof rejection, Organisation isolation, full rollback after a late policy error and
unchanged Evidence/Action/approval tables. It also proves both production
servers reject an unknown detector before listening. It prints local startup
p50/p95 for the original two packs and all three, plus the policy/Barrier query
plan; these timings are not GR-8 detector latency or Cloud Run measurements.

For a local migrated database, after building, start web-api with
`FIELDLOOP_DEFAULT_ORG_ID` and `DATABASE_URL` set to that disposable database.
Inspect `app.ai_system`, `app.guardrail_policy` and the referenced
`app.barrier_path`/`app.barrier` records. The Guardrail can start without a database
and report the validated catalog. Override `FIELDLOOP_DOMAIN_PACKS_DIR` to test
missing or malformed packs. Do not use production or prospect data for these checks.
