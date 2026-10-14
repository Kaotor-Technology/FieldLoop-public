import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { isRiskSeverity } from "../packages/contracts/dist/index.js";
import { sql } from "kysely";
import { loadDemoDomainPacks, registerDomainPackRecords, domainPackRecordId } from "../apps/api/dist/domain-packs.js";

/** Uses the caller's disposable PostGIS database; never connects to an environment. */
export async function testGenAiSafetyRecords(database, application, packs) {
  const orgId = "gen-ai-safety-test";
  const pack = packs.find(({ content }) => content.id === "gen-ai-safety");
  assert.ok(pack?.aiSafety, "required safety content");
  const safety = pack.aiSafety;
  const tables = ["threat_category", "bowtie", "independence_group", "threat", "consequence", "barrier", "barrier_path",
    "degradation_factor", "degradation_control", "ai_system", "guardrail_policy"];
  const counts = [4, 1, 1, 4, 2, 12, 15, 3, 3, 1, 4];
  const snapshot = async (org) => {
    const rows = [];
    for (const table of tables) {
      rows.push(...(await sql`SELECT ${table}::text AS kind, id, to_jsonb(t) AS value
        FROM ${sql.table(`app.${table}`)} t WHERE org_id = ${org} ORDER BY id`.execute(database)).rows);
    }
    return rows;
  };
  const existingHealth = (await sql`SELECT id, health FROM app.barrier ORDER BY id`.execute(database)).rows;
  const untouchedTables = ["health_proposal", "health_change", "action_request", "approval", "intercept", "held_request", "evidence", "cross_domain_link"];
  const unrelatedCounts = async () => Promise.all(untouchedTables.map(async (table) =>
    (await sql`SELECT count(*)::int AS count FROM ${sql.table(`app.${table}`)}`.execute(database)).rows[0].count));
  const before = await unrelatedCounts();
  await registerDomainPackRecords(application, orgId, [pack]);
  const first = await snapshot(orgId);
  for (const [index, table] of tables.entries()) assert.equal(first.filter(({ kind }) => kind === table).length, counts[index], table);
  assert.ok(first.every(({ value }) => value.simulated && value.classification === "CONFIDENTIAL"));
  assert.ok(first.filter(({ kind }) => kind === "barrier").every(({ value }) => value.health === "unverified"));
  const system = first.find(({ kind }) => kind === "ai_system").value;
  assert.equal(system.model_tier, "private");
  assert.deepEqual(system.data_classes, safety.aiSystem.dataClasses);
  assert.deepEqual(system.tools, safety.aiSystem.tools);
  assert.equal(system.risk_class, "high");
  const policyMappings = (await sql`SELECT p.config, p.mode, p.fail_mode, p.ai_system_id, b.type, b.side,
    b.triad->>'barrierCode' AS barrier_code FROM app.guardrail_policy p
    JOIN app.barrier b ON b.id = p.barrier_id AND b.org_id = p.org_id
    WHERE p.org_id = ${orgId} ORDER BY p.config->>'id'`.execute(application)).rows;
  assert.equal(policyMappings.length, 4);
  for (const row of policyMappings) {
    assert.equal(row.type, "technical");
    assert.equal(row.mode, "enforce");
    assert.equal(row.fail_mode, "fail-closed");
    assert.equal(row.ai_system_id, system.id);
    assert.equal(row.barrier_code, row.config.barrierId);
    assert.equal(row.config.bowtieId, first.find(({ kind }) => kind === "bowtie").id);
    assert.equal(row.side, row.config.kind === "output-dlp" ? "mitigative" : "preventive");
  }
  for (const row of first.filter(({ kind }) => kind === "consequence")) {
    assert.equal(isRiskSeverity(row.value.severity), true, "persisted Consequence conforms to shared RiskSeverity");
  }
  assert.deepEqual(first.find(({ kind, value }) => kind === "consequence" && value.name === "Disclosure of restricted Asset data").value.severity,
    { legalRegulatory: 5 });
  assert.deepEqual(first.filter(({ kind }) => kind === "consequence").map(({ value }) => Object.values(value.severity)[0]).sort(), [4, 5]);
  assert.ok(first.filter(({ kind }) => kind === "threat").every(({ value }) => value.frequency_per_year === null));
  assert.ok(first.filter(({ kind }) => kind === "consequence").every(({ value }) => value.p_conditional === null));
  await registerDomainPackRecords(application, orgId, [pack]);
  assert.deepEqual(await snapshot(orgId), first, "idempotent seed preserves every row");
  const barrierId = domainPackRecordId(orgId, pack.content.id, "barrier", safety.policies[0].barrierId);
  await sql`UPDATE app.barrier SET health = 'degraded' WHERE id = ${barrierId}::uuid`.execute(database);
  await registerDomainPackRecords(application, orgId, [pack]);
  assert.equal((await sql`SELECT health FROM app.barrier WHERE id = ${barrierId}::uuid`.execute(database)).rows[0].health, "degraded", "reload preserves human-reviewed Health");
  const updated = structuredClone(pack);
  updated.content.version = "1.0.1";
  updated.aiSafety.version = "1.0.1";
  await registerDomainPackRecords(application, orgId, [updated]);
  const upgraded = await snapshot(orgId);
  assert.deepEqual(upgraded.map(({ id }) => id), first.map(({ id }) => id));
  assert.ok(upgraded.filter(({ kind }) => kind === "guardrail_policy").every(({ value }) => value.config.packVersion === "1.0.1"));
  await registerDomainPackRecords(application, "other-gen-ai-safety-test", [pack]);
  const other = await snapshot("other-gen-ai-safety-test");
  assert.equal(other.length, first.length);
  assert.ok(other.every(({ id }) => !first.some((row) => row.id === id)));
  assert.deepEqual(await snapshot(orgId), upgraded, "other Organisation leaves original rows intact");
  const broken = structuredClone(pack);
  broken.aiSafety.policies[3].barrierId = "missing-barrier";
  await assert.rejects(registerDomainPackRecords(application, "rollback-gen-ai-safety-test", [broken]), /foreign key/);
  assert.deepEqual(await snapshot("rollback-gen-ai-safety-test"), [], "late policy FK failure rolls back all seed tables");
  const healthAfter = (await sql`SELECT id, health FROM app.barrier WHERE org_id NOT IN (${orgId}, 'other-gen-ai-safety-test') ORDER BY id`.execute(database)).rows;
  assert.deepEqual(healthAfter, existingHealth, "pre-existing Health stays unchanged");
  assert.deepEqual(await unrelatedCounts(), before, "no fabricated Evidence, Intercepts, Health changes, Actions, approvals or unresolved Cross-Domain rows");
  const bowtieId = domainPackRecordId(orgId, pack.content.id, "bowtie", safety.bowtie.id);
  await sql`UPDATE app.bowtie SET status = 'approved', hazard = 'Human-reviewed hazard (SIMULATION)'
    WHERE id = ${bowtieId}::uuid`.execute(database);
  const reviewed = await snapshot(orgId);
  await registerDomainPackRecords(application, orgId, [updated]);
  assert.deepEqual(await snapshot(orgId), reviewed, "identical seed must not overwrite reviewed definitions or local overrides");
  const equivalent = structuredClone(updated);
  equivalent.aiSafety = Object.fromEntries(Object.entries(equivalent.aiSafety).reverse());
  equivalent.content = Object.fromEntries(Object.entries(equivalent.content).reverse());
  await registerDomainPackRecords(application, orgId, [equivalent]);
  assert.deepEqual(await snapshot(orgId), reviewed, "object-key ordering does not change seed identity");
  const edits = [
    (value) => { value.aiSafety.bowtie.hazard = "Changed hazard (SIMULATION)"; },
    (value) => { value.aiSafety.bowtie.barriers[0].performanceStandard = "Changed standard (SIMULATION)"; },
    (value) => { value.aiSafety.bowtie.paths[0].barrierIds.reverse(); },
    (value) => { value.aiSafety.policies[0].id = "renamed-injection-policy"; },
    (value) => { value.content.version = "1.0.2"; value.aiSafety.version = "1.0.2"; },
  ];
  for (const edit of edits) {
    const changed = structuredClone(updated);
    edit(changed);
    await assert.rejects(registerDomainPackRecords(application, orgId, [changed]), /reviewed Bowtie/);
    assert.deepEqual(await snapshot(orgId), reviewed, "reviewed reload rejection rolls back every catalog table");
  }
  for (const status of ["in_review", "rejected", "superseded"]) {
    await sql`UPDATE app.bowtie SET status = ${status} WHERE id = ${bowtieId}::uuid`.execute(database);
    const protectedState = await snapshot(orgId);
    const changed = structuredClone(updated);
    changed.aiSafety.bowtie.hazard = "Changed reviewed-state hazard (SIMULATION)";
    await assert.rejects(registerDomainPackRecords(application, orgId, [changed]), /reviewed Bowtie/);
    assert.deepEqual(await snapshot(orgId), protectedState, `seed preserves ${status} definitions`);
  }
  await sql`UPDATE app.bowtie SET status = 'approved' WHERE id = ${bowtieId}::uuid`.execute(database);
  // A concurrent human review must win over a seed that began before its commit.
  await sql`UPDATE app.bowtie SET status = 'draft' WHERE id = ${bowtieId}::uuid`.execute(database);
  const concurrent = structuredClone(updated);
  concurrent.aiSafety.bowtie.hazard = "Concurrent seed edit (SIMULATION)";
  let seedWork;
  let settled = false;
  await database.transaction().execute(async (humanReview) => {
    await sql`UPDATE app.bowtie SET status = 'approved' WHERE id = ${bowtieId}::uuid`.execute(humanReview);
    seedWork = registerDomainPackRecords(application, orgId, [concurrent]);
    void seedWork.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(settled, false, "seed waits for the concurrent reviewed Bowtie row");
  });
  await assert.rejects(seedWork, /reviewed Bowtie/);
  assert.deepEqual(await snapshot(orgId), reviewed, "seed cannot overwrite a concurrently reviewed definition");
  const policyIdForProof = domainPackRecordId(orgId, pack.content.id, "guardrail_policy", policyMappings[0].config.id);
  const policyConfig = (await sql`SELECT config FROM app.guardrail_policy
    WHERE id = ${policyIdForProof}::uuid`.execute(database)).rows[0].config;
  await sql`UPDATE app.guardrail_policy SET config = config - 'seedDefinitionHash'
    WHERE id = ${policyIdForProof}::uuid`.execute(database);
  const legacyReviewed = await snapshot(orgId);
  await assert.rejects(registerDomainPackRecords(application, orgId, [updated]), /reviewed Bowtie/);
  assert.deepEqual(await snapshot(orgId), legacyReviewed, "missing legacy proof is never silently adopted");
  await sql`UPDATE app.guardrail_policy SET config = ${JSON.stringify(policyConfig)}::jsonb
    WHERE id = ${policyIdForProof}::uuid`.execute(database);
  const times = [];
  for (let index = 0; index < 25; index++) {
    const start = performance.now();
    const loaded = await loadDemoDomainPacks();
    await registerDomainPackRecords(application, "gen-ai-safety-perf", loaded);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  console.log(`All three packs startup + DB registration (25 samples): p50=${times[12].toFixed(2)} ms p95=${times[23].toFixed(2)} ms`);
  const policyId = first.find(({ kind }) => kind === "guardrail_policy").id;
  const plan = await sql`EXPLAIN (ANALYZE, BUFFERS) SELECT p.config, b.triad
    FROM app.guardrail_policy p JOIN app.barrier b ON b.id = p.barrier_id AND b.org_id = p.org_id
    WHERE p.id = ${policyId}::uuid AND p.org_id = ${orgId}`.execute(application);
  console.log(plan.rows.map((row) => row["QUERY PLAN"]).join("\n"));
  const invalidRoot = await mkdtemp(join(tmpdir(), "fl85-startup-"));
  try {
    await cp(new URL("../domain-packs/", import.meta.url), invalidRoot, { recursive: true });
    const file = join(invalidRoot, "gen-ai-safety", "ai-safety.yaml");
    await writeFile(file, (await readFile(file, "utf8")).replace("detector: model-armor", "detector: absent-detector"));
    for (const service of ["api", "guardrail"]) {
      const failed = spawnSync(process.execPath, [`apps/${service}/dist/server.js`], {
        encoding: "utf8", timeout: 10000, env: { ...process.env, FIELDLOOP_DOMAIN_PACKS_DIR: invalidRoot },
      });
      assert.equal(failed.status, 1, `${service} must reject unknown detectors before listening`);
      assert.match(failed.stderr, /ai-safety.yaml.*detector/);
      assert.doesNotMatch(failed.stdout, /Server listening/);
    }
  } finally { await rm(invalidRoot, { recursive: true, force: true }); }
  const parentPlan = await sql`EXPLAIN (ANALYZE, BUFFERS) SELECT status, version FROM app.bowtie
    WHERE id = ${bowtieId}::uuid AND org_id = ${orgId} FOR UPDATE`.execute(application);
  console.log(parentPlan.rows.map((row) => row["QUERY PLAN"]).join("\n"));
  console.log("Gen AI Safety PostGIS acceptance passed: UC-1, 4 policies, full Bowtie C, mappings, labels, idempotency, upgrade, preserved Health/reviewed definitions, concurrent human review, shared severity, Organisation isolation and rollback.");
}
