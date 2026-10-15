import { testGenAiSafetyRecords } from "./test-gen-ai-safety.mjs";
import { testGuardrailAcceptance } from "./test-guardrail-acceptance.mjs";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { loadDomainPacks } from "../packages/adapters/dist/domain-pack-loader.js";
import { DEMO_AGENT_TOOL_NAMES, loadDemoDomainPacks, registerDomainPackRecords } from "../apps/api/dist/domain-packs.js";
import { createProductionAuthRuntime } from "../apps/api/dist/auth/runtime.js";
import { loadSeed as loadDlSeed } from "../db/seed/dl-01/seed.mjs";
import { loadSeed as loadBangkokSeed } from "../db/seed/bangkok/seed.mjs";
import { buildDataset as buildDl } from "../data/synthetic/dl-01/generate.mjs";
import { buildDataset as buildBangkok } from "../data/synthetic/bangkok/generate.mjs";

const connectionString = process.env.FIELDLOOP_PACK_TEST_DATABASE_URL;
if (!connectionString) throw new Error("FIELDLOOP_PACK_TEST_DATABASE_URL is required; use pnpm test:domain-packs");
const database = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 1 }) }) });
const application = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 1, options: "-c role=fieldloop_app" }) }) });
const orgId = "pack-test-org";
const snapshot = async (org) => (await sql`
  SELECT 'rule' AS kind, id, to_jsonb(r) AS value FROM app.signal_rule r WHERE org_id = ${org}
  UNION ALL
  SELECT 'category' AS kind, id, to_jsonb(t) AS value FROM app.threat_category t WHERE org_id = ${org}
  ORDER BY kind, id`.execute(database)).rows;

try {
  await loadDlSeed(database, buildDl(), orgId);
  await loadBangkokSeed(database, buildBangkok(), orgId);
  const healthBefore = (await sql`SELECT id, health FROM app.barrier ORDER BY id`.execute(database)).rows;
  // Raw content baseline remains separate from the derived UC-4 Guardrail registration.
  const packs = (await loadDomainPacks(new URL("../domain-packs/", import.meta.url), DEMO_AGENT_TOOL_NAMES))
    .filter(({ aiSafety }) => !aiSafety);
  // Also exercise the optional spatial field accepted by the same loader schema.
  packs[0].content.signalRules[0].spatialGeometry = {
    type: "Polygon", coordinates: [[[100, 13], [101, 13], [101, 14], [100, 14], [100, 13]]],
  };
  await registerDomainPackRecords(application, orgId, packs);
  const first = await snapshot(orgId);
  assert.equal(first.filter(({ kind }) => kind === "rule").length, 5);
  assert.equal(first.filter(({ kind }) => kind === "category").length, 8);
  assert.ok(first.every(({ value }) => value.simulated === true && value.classification === "CONFIDENTIAL"));
  await registerDomainPackRecords(application, orgId, packs);
  assert.deepEqual(await snapshot(orgId), first, "restart must preserve identical rows and IDs");
  const saved = { database: process.env.DATABASE_URL, org: process.env.FIELDLOOP_DEFAULT_ORG_ID, kms: process.env.FIELDLOOP_SESSION_KMS_KEY };
  process.env.DATABASE_URL = connectionString;
  process.env.FIELDLOOP_DEFAULT_ORG_ID = orgId;
  delete process.env.FIELDLOOP_SESSION_KMS_KEY;
  try {
    const runtime = await createProductionAuthRuntime();
    try {
      assert.equal(typeof runtime.registerPacks, "function", "configured database must register packs without BFF secrets");
      await runtime.registerPacks(packs);
      assert.deepEqual(await snapshot(orgId), first);
    } finally { await runtime.close(); }
  } finally {
    for (const [name, value] of [["DATABASE_URL", saved.database], ["FIELDLOOP_DEFAULT_ORG_ID", saved.org], ["FIELDLOOP_SESSION_KMS_KEY", saved.kms]]) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  }
  const invalidRoot = await mkdtemp(join(tmpdir(), "fl78-server-invalid-"));
  try {
    await mkdir(join(invalidRoot, "flood-water"));
    await writeFile(join(invalidRoot, "flood-water", "pack.yaml"), "id: [broken");
    const failed = spawnSync(process.execPath, ["apps/api/dist/server.js"], {
      encoding: "utf8", timeout: 10000, env: { ...process.env, FIELDLOOP_DOMAIN_PACKS_DIR: invalidRoot },
    });
    assert.equal(failed.status, 1, "production server must fail before listening on malformed YAML");
    assert.match(failed.stderr, /pack.yaml.*invalid YAML/);
    assert.doesNotMatch(failed.stdout, /Server listening/);
  } finally { await rm(invalidRoot, { recursive: true, force: true }); }
  const geometry = (await sql`SELECT ST_AsGeoJSON(spatial_geom)::jsonb AS geometry, ST_SRID(spatial_geom) AS srid
    FROM app.signal_rule WHERE org_id = ${orgId} AND condition->>'ruleId' = 'rainfall-needs-fresh-evidence'`.execute(database)).rows[0];
  assert.equal(geometry.srid, 4326);
  assert.deepEqual(geometry.geometry, packs[0].content.signalRules[0].spatialGeometry);
  await registerDomainPackRecords(application, "other-pack-test-org", packs);
  const other = await snapshot("other-pack-test-org");
  assert.equal(other.length, first.length);
  assert.ok(other.every(({ id }) => !first.some((row) => row.id === id)));
  assert.deepEqual(await snapshot(orgId), first, "other Organisation must not overwrite these rows");
  const broken = structuredClone(packs);
  broken[1].content.classification = "INVALID";
  await assert.rejects(registerDomainPackRecords(application, "rollback-test-org", broken), /classification/);
  assert.deepEqual(await snapshot("rollback-test-org"), [], "later failure must roll back earlier pack inserts");
  await assert.rejects(registerDomainPackRecords(application, " ", packs), /Organisation ID/);
  assert.deepEqual((await sql`SELECT id, health FROM app.barrier ORDER BY id`.execute(database)).rows, healthBefore);
  assert.equal((await sql`SELECT count(*)::int AS count FROM app.health_proposal`.execute(database)).rows[0].count, 0);
  assert.equal((await sql`SELECT count(*)::int AS count FROM app.action_request`.execute(database)).rows[0].count, 0);
  // Upgrade retained IDs in place without duplicating records.
  const updated = structuredClone(packs);
  updated[0].content.version = "1.0.1";
  updated[0].content.signalRules[0].condition.threshold = 120;
  await registerDomainPackRecords(application, orgId, updated);
  const upgraded = await snapshot(orgId);
  assert.deepEqual(upgraded.map(({ id }) => id), first.map(({ id }) => id));
  assert.equal(upgraded.find(({ value }) => value.condition?.ruleId === "rainfall-needs-fresh-evidence").value.condition.threshold, 120);
  // Startup-only work: measure 25 local reloads, without claiming a Cloud Run SLO.
  const times = [];
  for (let index = 0; index < 25; index++) {
    const start = performance.now();
    const loaded = await loadDomainPacks(new URL("../domain-packs/", import.meta.url), DEMO_AGENT_TOOL_NAMES, ["pipeline-integrity", "flood-water"]);
    await registerDomainPackRecords(application, orgId, loaded);
    times.push(performance.now() - start);
  }
  times.sort((left, right) => left - right);
  console.log(`Two-pack baseline load + DB registration (25 samples): p50=${times[12].toFixed(2)} ms p95=${times[23].toFixed(2)} ms`);
  const id = first.find(({ kind }) => kind === "rule").id;
  const plan = await sql`EXPLAIN (ANALYZE, BUFFERS) INSERT INTO app.signal_rule
    (id, org_id, pack, condition, target_barrier_selector, simulated, classification, created_by)
    SELECT id, org_id, pack, condition, target_barrier_selector, simulated, classification, created_by
    FROM app.signal_rule WHERE id = ${id}::uuid
    ON CONFLICT (id) DO UPDATE SET condition = EXCLUDED.condition`.execute(application);
  console.log(plan.rows.map((row) => row["QUERY PLAN"]).join("\n"));
  await testGenAiSafetyRecords(database, application, await loadDemoDomainPacks());
  await testGuardrailAcceptance(database, connectionString, await loadDemoDomainPacks());
  console.log("Domain Pack PostGIS integration passed: application grants, restart, update, spatial persistence, Organisation isolation, rollback and unchanged Health.");
} finally {
  await application.destroy();
  await database.destroy();
}
