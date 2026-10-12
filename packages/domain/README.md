# @fieldloop/domain — Risk Score (FL-80)

`calculateRisk(input)` is the single pure implementation of PRD AS-3–AS-9.
Import it from `@fieldloop/domain/risk` (also exported at the package root).
`RiskInput` and `RiskSnapshot` are generated from the shared
[`risk.v1.schema.json`](../contracts/risk.v1.schema.json); no handwritten client
or persisted snapshot is introduced here. API, snapshot storage and events are FL-81.

- Threat contribution: `frequencyPerYear × path PFD`; Top Event frequency is
  the sum. Consequence frequency is `F × conditionalProbability × path PFD`.
- Healthy uses base PFD; Degraded/Unverified uses `min(1, PFD × 10)`; Failed
  always uses 1. Human/Organisational base PFD cannot be below 0.1;
  Technical cannot be below 0.01 unless explicitly certified (AS-4).
- The caller verifies certification and computes `evidenceExpired` for qualifying
  Evidence at its explicit evaluation time. Expiry projects Healthy/Degraded to
  Unverified **only for this calculation**; Failed stays Failed. Input and stored
  Health are never changed. The scheduled ageing job belongs to FL-82.
- Each Independence Group credits the lowest **effective** PFD on each path.
  Equal-PFD ties choose the lexically smallest Barrier ID. Shared Barriers can
  be credited on separate paths. A path with no Barriers has PFD 1.
- Each Threat and Consequence requires exactly one explicit path. Missing,
  orphaned, duplicate or wrong-side references fail. Parallel alternative paths
  are rejected because their correlation/combination rule is unspecified by
  AS-7. No result is returned for invalid inputs or numeric overflow/underflow.
- Severity is the worst supplied band among People, Environment, Financial,
  Service continuity, Reputation and Legal/Regulatory. The caller maps measured
  severity to the Organisation's bands; the engine does not guess definitions.
- The Organisation must provide all 25 matrix cells, their zones and integer
  ranks. Rows are frequency bands 1–5; columns are severity bands 1–5. Increasing
  either band must not improve rank or zone. No product-score/colour calibration
  is silently installed by this module.
- The worst Consequence orders red > amber > green, then rank, severity band,
  frequency band, then the lexically smallest Consequence ID. Rank is supplied
  by the Organisation rather than inferred from multiplying bands.

## Boundary assumptions proposed for review

The PRD's adjoining frequency ranges do not define equality. Thresholds are
lower-inclusive: `[1e-5, 1e-4, 1e-3, 1e-2]` puts exactly `1e-2` in band 5.
Cell rank and stable tie ordering above make "worst cell" deterministic without
inventing tolerability zones. These choices are recorded as proposals in
[`FL-80 context`](../../docs/contexts/FL-80.md).

Binary64 arithmetic is not rounded during calculation. Golden expectations are
independent hand calculations using the authored SYNTHETIC Bowtie A/D parameters;
the PRD supplies structures and severity bands, not measured frequencies. Tests
compare frequencies within binary64 precision, not presentation-rounded values.
Bowties B/C have no complete numeric seeds yet. Their golden tests use the PRD
topology with explicitly simulated test calibration (each Threat 1/year, each
conditional probability 0.1, default PFD ceilings and assumed independence).
These arithmetic checks are not approved seed calibration or Cross-Domain math;
repeat them against authored B/C seeds when those are available.

## Validation

`pnpm --filter @fieldloop/domain test` covers the A/D seed and B/C illustrative golden values, Health/PFD
ceilings, Q60 property across 404 group/PFD combinations, per-path independence,
all frequency boundaries, worst severity/cell, deterministic input reordering,
invalid references and numeric errors. The existing CI `pnpm test` gate runs them.

After `pnpm build`, `node packages/domain/perf/risk-benchmark.mjs` reports 1,000
local Bowtie A calculation samples (100 warmups), including schema validation.
This measures local calculation time only; the <5 s Health-to-Risk event budget
must also be tested through FL-81's API/worker integration. No network calls,
cloud resources or additional GCP spend are introduced.
