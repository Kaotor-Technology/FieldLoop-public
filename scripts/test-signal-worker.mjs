import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { PostgresWorkerStore } from "../apps/signal-worker/dist/postgres-store.js";
import { buildApp } from "../apps/signal-worker/dist/app.js";
import { loadSeed as loadDlSeed } from "../db/seed/dl-01/seed.mjs";
import { loadSeed as loadFloodSeed } from "../db/seed/bangkok/seed.mjs";
import { buildDataset as dlDataset } from "../data/synthetic/dl-01/generate.mjs";
import { buildDataset as floodDataset } from "../data/synthetic/bangkok/generate.mjs";

// Use only disposable local PostGIS. No Cloud SQL configuration or credentials are read.
const container = `fieldloop-worker-fixture-${process.pid}`;
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const orgId = "worker-fixture", otherOrg = "other-worker-fixture";
let database, application, app;
const condition = (ruleId, source, tag, threshold, unit, health, extra = {}) => ({ kind: "signal", ruleId, packVersion: "1.0.0", source, tag,
  operator: "eq", threshold, unit, effect: { kind: "health_proposal", proposedHealth: health, reason: "SIMULATION periodic measurement requires human review" }, ...extra });
const rules = [
  { pack: "pipeline-integrity", condition: condition("cp-rectifier-output-lost", "mock-historian", "DL-01.rectifier.output", 0, "A", "failed"),
    selector: { pack: "pipeline-integrity", bowtieCode: "dl-01-bowtie-a", barrierCodes: ["cathodic-protection"] } },
  { pack: "pipeline-integrity", condition: condition("encroachment-detected", "mock-patrol", "DL-01.encroachment.detected", 1, "boolean", "degraded"),
    selector: { pack: "pipeline-integrity", bowtieCode: "dl-01-bowtie-a", barrierCodes: ["right-of-way-patrol", "excavation-permit-one-call"] } },
  { pack: "flood-water", condition: condition("rainfall-needs-fresh-evidence", "mock-hydro", "rain.accumulation.24h", 100, "mm", "unverified", { operator: "gt", windowSeconds: 86400 }),
    selector: { pack: "flood-water", bowtieCode: "bangkok-bowtie-d", barrierCodes: ["pumping-stations", "water-gates", "tidal-gates"] } },
  { pack: "flood-water", condition: condition("pump-power-lost", "mock-pumps", "pump.power", 0, "boolean", "degraded"),
    selector: { pack: "flood-water", bowtieCode: "bangkok-bowtie-d", barrierCodes: ["pumping-stations"] } },
];
// These rule rows snapshot FL-78 PR #44 head 68b31d9563a3cd88d27fb3356e0140d00f59ce65.
// PR #47 head ca30d5ab574da9e29dc51eb8a2dda21efbcbdf87 emits different rain and pump shapes;
// the source-contract samples below do not infer conversions between those contracts.
const intervals = { "mock-historian": { months: 3 }, "mock-patrol": { months: 3 }, "mock-hydro": 60, "mock-pumps": 60 };
const base = { schemaVersion: "signal.v1", orgId, source: "mock-historian", tag: "DL-01.rectifier.output", value: 0, unit: "A",
  observedAt: "2026-10-13T00:00:00Z", simulated: true, classification: "CONFIDENTIAL" };
const reading = (changes = {}) => ({ ...base, id: randomUUID(), ...changes });
const count = async (table, where = sql``) => (await sql`SELECT count(*)::int AS count FROM ${sql.table(`app.${table}`)} WHERE org_id = ${orgId} ${where}`.execute(database)).rows[0].count;
const snapshot = async () => (await sql`SELECT id, health FROM app.barrier ORDER BY id`.execute(database)).rows;
try {
  execFileSync("docker", ["build", "-q", "-t", "fieldloop-db-test:pg16", "-"], { input: readFileSync("db/test/Dockerfile"), stdio: ["pipe", "inherit", "inherit"] });
  docker("run", "--rm", "-d", "--name", container, "-e", "POSTGRES_PASSWORD=fixture", "-e", "POSTGRES_DB=fieldloop_dev", "-p", "127.0.0.1::5432", "fieldloop-db-test:pg16");
  for (let attempt = 0; attempt < 60; attempt++) {
    try { docker("exec", container, "pg_isready", "-q", "-h", "127.0.0.1", "-U", "postgres"); break; }
    catch { await setTimeout(500); }
  }
  docker("exec", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "fieldloop_dev", "-c", 'CREATE ROLE "fl-v2-signal-worker-dev@example-project.iam" NOLOGIN');
  const migrations = readdirSync("db/migrations").filter((file) => file.endsWith(".sql")).sort()
    .map((file) => readFileSync(`db/migrations/${file}`, "utf8").split("-- migrate:down")[0]).join("\n");
  execFileSync("docker", ["exec", "-i", container, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "fieldloop_dev"], { input: migrations, stdio: ["pipe", "pipe", "pipe"] });
  const port = docker("port", container, "5432").split(":").at(-1);
  const connectionString = `postgres://postgres:fixture@127.0.0.1:${port}/fieldloop_dev`;
  database = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }) });
  application = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, options: "-c role=fl-v2-signal-worker-dev@example-project.iam", max: 5 }) }) });
  for (const org of [orgId, otherOrg]) {
    await loadDlSeed(database, dlDataset(), org); await loadFloodSeed(database, floodDataset(), org);
    for (const rule of rules) {
      rule.id ??= randomUUID();
      await sql`INSERT INTO app.signal_rule (id, org_id, pack, condition, target_barrier_selector, simulated, classification, created_by)
        VALUES (${org === orgId ? rule.id : randomUUID()}::uuid, ${org}, ${rule.pack}, ${JSON.stringify(rule.condition)}::jsonb, ${JSON.stringify(rule.selector)}::jsonb,
          true, 'CONFIDENTIAL', 'worker-fixture')`.execute(database);
    }
  }
  const store = new PostgresWorkerStore(application, orgId, intervals);
  await store.initialize(); await store.initialize();
  assert.equal(await count("signal_dependency"), 7);
  const healthBefore = await snapshot();
  const otherHealthBefore = (await sql`SELECT id, health FROM app.barrier WHERE org_id = ${otherOrg} ORDER BY id`.execute(database)).rows;
  await assert.rejects(sql`SELECT access_token FROM app.user_session LIMIT 1`.execute(application), /permission denied/);
  await assert.rejects(sql`UPDATE app.audit_event SET action = 'forged' WHERE false`.execute(application), /permission denied/);
  const first = reading();
  await Promise.all(Array.from({ length: 10 }, () => store.ingest(first)));
  assert.equal(await count("signal"), 1); assert.equal(await count("signal_receipt"), 1);
  assert.equal(await count("health_proposal"), 1); assert.equal(await count("evidence", sql`AND signal_receipt_id IS NOT NULL`), 1);
  assert.deepEqual(await snapshot(), healthBefore, "Signal must never apply proposed Health");
  await assert.rejects(store.ingest({ ...first, value: 2 }), /identity reused/);
  await assert.rejects(store.ingest({ ...first, orgId: otherOrg }), /Organisation/);
  assert.equal(await count("signal"), 1);
  const existingEvents = (await sql`SELECT event FROM app.signal_event_outbox WHERE org_id = ${orgId} ORDER BY id`.execute(database)).rows;
  await assert.rejects(store.publishPending(async () => { throw new Error("queue failure"); }), /queue failure/);
  await store.ingest(first);
  assert.equal(await count("health_proposal"), 1);
  const delivered = [];
  await store.publishPending(async (event) => { delivered.push(event); });
  await store.publishPending(async (event) => { delivered.push(event); });
  assert.deepEqual(delivered.map(({ id }) => id).sort(), existingEvents.map(({ event }) => event.id).sort());
  assert.equal(delivered.filter(({ type }) => type === "health_proposal.created").length, 1);

  // Wrong source/type/unit/provenance cannot become qualifying Evidence or liveness.
  for (const changes of [{ source: "unknown" }, { unit: "mA" }, { value: "0" }, { value: null }, { simulated: false }, { assetId: randomUUID() }, { barrierId: randomUUID() }]) {
    await store.ingest(reading({ observedAt: "2026-10-13T00:01:00Z", ...changes }));
  }
  assert.equal(await count("health_proposal"), 1); assert.equal(await count("evidence", sql`AND signal_receipt_id IS NOT NULL`), 1);
  await store.ingest(reading({ observedAt: "2026-10-12T23:00:00Z" }));
  assert.equal(await count("health_proposal"), 1, "out-of-order reading must not raise a stale proposal");
  await store.ingest(reading({ source: "mock-patrol", tag: "DL-01.encroachment.detected", value: true, unit: "boolean" }));
  assert.equal(await count("health_proposal"), 3);
  await store.ingest(reading({ source: "mock-hydro", tag: "rain.accumulation.24h", value: 100, unit: "mm" }));
  assert.equal(await count("health_proposal"), 3, "rain threshold is strictly greater than 100");
  await store.ingest(reading({ source: "mock-hydro", tag: "rain.accumulation.24h", value: 101, unit: "mm", observedAt: "2026-10-13T00:01:00Z" }));
  assert.equal(await count("health_proposal"), 6, "source reports a 24-hour aggregate, not a duration");
  await store.ingest(reading({ source: "mock-pumps", tag: "pump.power", value: false, unit: "boolean" }));
  assert.equal(await count("health_proposal"), 7);
  assert.deepEqual(await snapshot(), healthBefore);

  // Exact source fields from PR #47's Observation + SimulatedSignalEmitter, not its edited shared
  // signal-cases.json. Current FL-78 rules above do not match these; persist them without fabricating
  // Evidence or Proposals until the source and pack contracts are aligned.
  const rainSourceSample = reading({ source: "mock-hydro", tag: "S-R1.rain.rate", value: 60, unit: "mm/h",
    observedAt: "2026-10-13T00:02:00Z", payload: { assetCode: "S-R1", zoneCode: "Z3", kind: "rain", label: "SIMULATION" } });
  const pumpSourceSample = reading({ source: "mock-pumps", tag: "P-3.pump.power", value: "lost", unit: undefined,
    observedAt: "2026-10-13T00:03:00Z", payload: { assetCode: "P-3", facilityType: "pump", zoneCode: "Z3", operatingState: "stopped", label: "SIMULATION" } });
  const proposalsBeforeSourceSamples = await count("health_proposal");
  const evidenceBeforeSourceSamples = await count("evidence", sql`AND signal_receipt_id IS NOT NULL`);
  await store.ingest(rainSourceSample);
  await store.ingest(pumpSourceSample);
  assert.equal(await count("signal_receipt", sql`AND id IN (${rainSourceSample.id}::uuid, ${pumpSourceSample.id}::uuid)`), 2);
  assert.equal(await count("health_proposal"), proposalsBeforeSourceSamples);
  assert.equal(await count("evidence", sql`AND signal_receipt_id IS NOT NULL`), evidenceBeforeSourceSamples);

  // Strict duration requires enough successive observations; sparse inspections never establish continuity.
  await sql`UPDATE app.signal_rule SET condition = condition || '{"durationSeconds":120,"expectedIntervalSeconds":60}'::jsonb WHERE id = ${rules[0].id}::uuid`.execute(database);
  const run = randomUUID();
  for (const seconds of [0, 60, 120, 121]) await store.ingest(reading({ simulationRunId: run, observedAt: new Date(Date.parse(base.observedAt) + (600 + seconds) * 1000).toISOString() }));
  assert.equal(await count("health_proposal"), 8);
  const sparseRun = randomUUID();
  for (const seconds of [0, 180]) await store.ingest(reading({ simulationRunId: sparseRun, observedAt: new Date(Date.parse(base.observedAt) + (1000 + seconds) * 1000).toISOString() }));
  assert.equal(await count("health_proposal"), 8);
  await sql`UPDATE app.signal_rule SET condition = condition - 'durationSeconds' - 'expectedIntervalSeconds' WHERE id = ${rules[0].id}::uuid`.execute(database);

  // Spatial rule: boundary covered, outside/missing/invalid location do not match.
  await sql`UPDATE app.signal_rule SET spatial_geom = ST_MakeEnvelope(100, 13, 101, 14, 4326) WHERE id = ${rules[0].id}::uuid`.execute(database);
  for (const payload of [{}, { location: { type: "Point", coordinates: [102, 13.5] } }, { location: { type: "Point", coordinates: [999, 13.5] } }]) {
    await store.ingest(reading({ observedAt: "2026-10-13T01:00:00Z", payload }));
  }
  assert.equal(await count("health_proposal"), 8);
  await store.ingest(reading({ observedAt: "2026-10-13T01:00:01Z", payload: { location: { type: "Point", coordinates: [100, 13.5] } } }));
  assert.equal(await count("health_proposal"), 9);
  await sql`UPDATE app.signal_rule SET spatial_geom = NULL WHERE id = ${rules[0].id}::uuid`.execute(database);

  await store.ingest(reading({ simulationRunId: randomUUID(), observedAt: base.observedAt }));
  assert.equal(await count("health_proposal"), 10, "a new Scenario run must not inherit the previous run's observation watermark");

  // Transaction rollback after a later failure must remove receipt, Signal and Evidence as well.
  await sql`ALTER TABLE app.health_proposal ADD CONSTRAINT fixture_proposal_failure CHECK (reason <> 'rollback fixture') NOT VALID`.execute(database);
  await sql`UPDATE app.signal_rule SET condition = jsonb_set(condition, '{effect,reason}', '"rollback fixture"') WHERE id = ${rules[0].id}::uuid`.execute(database);
  const beforeRollback = await count("signal"), rejected = reading({ observedAt: "2026-10-13T02:00:00Z" });
  await assert.rejects(store.ingest(rejected), /fixture_proposal_failure/);
  assert.equal(await count("signal"), beforeRollback); assert.equal(await count("signal_receipt", sql`AND id = ${rejected.id}::uuid`), 0);
  await sql`ALTER TABLE app.health_proposal DROP CONSTRAINT fixture_proposal_failure`.execute(database);
  await sql`UPDATE app.signal_rule SET condition = jsonb_set(condition, '{effect,reason}', '"SIMULATION periodic reading"') WHERE id = ${rules[0].id}::uuid`.execute(database);

  await store.ingest(reading({ source: "mock-patrol", tag: "DL-01.encroachment.detected", value: 0, unit: "boolean", classification: "HIGHLY_RESTRICTED", observedAt: "2026-10-13T02:00:00Z" }));
  await store.initialize();
  assert.equal(await count("signal_dependency", sql`AND classification = 'HIGHLY_RESTRICTED'`), 2, "restart must preserve source classification");

  // Never-heard and recently-heard sources share receipt-clock checks. Failed always stays Failed.
  await sql`UPDATE app.barrier SET health = 'healthy' WHERE org_id = ${orgId}`.execute(database);
  await sql`UPDATE app.barrier SET health = 'failed' WHERE org_id = ${orgId} AND code = 'cathodic-protection'`.execute(database);

  const deadline = new Date("2026-10-31T03:00:00Z");
  await sql`UPDATE app.signal_dependency SET created_at = ${deadline}, last_received_at = ${deadline}, last_observed_at = NULL WHERE org_id = ${orgId}`.execute(database);
  assert.equal(await store.detectSilence(new Date(deadline.getTime() + 60_000)), 0, "exact interval is not silent");
  assert.equal(await store.detectSilence(new Date(deadline.getTime() + 60_001)), 3);
  assert.equal(await store.detectSilence(new Date("2027-01-31T03:00:00Z")), 0, "exact quarterly boundary is not silent");
  assert.equal(await store.detectSilence(new Date("2027-01-31T03:00:00.001Z")), 2);
  assert.equal(await store.detectSilence(new Date("2027-01-31T03:00:00.002Z")), 0);
  assert.equal((await sql`SELECT health FROM app.barrier WHERE org_id = ${orgId} AND code = 'cathodic-protection'`.execute(database)).rows[0].health, "failed");
  assert.equal(await count("health_change"), 5); assert.equal(await count("audit_event"), 5);
  assert.equal(await count("audit_event", sql`AND prev_hash IS NOT NULL`), 4);
  assert.equal(await count("health_change", sql`AND classification = 'HIGHLY_RESTRICTED'`), 2);
  assert.equal((await sql`SELECT count(*)::int AS count FROM app.health_proposal WHERE org_id = ${otherOrg}`.execute(database)).rows[0].count, 0);
  assert.deepEqual((await sql`SELECT id, health FROM app.barrier WHERE org_id = ${otherOrg} ORDER BY id`.execute(database)).rows, otherHealthBefore);
  await store.ingest(reading({ observedAt: "2026-10-13T04:00:00Z" }));
  assert.equal((await sql`SELECT health FROM app.barrier WHERE org_id = ${orgId} AND code = 'cathodic-protection'`.execute(database)).rows[0].health, "failed");

  // Calendar months follow Bangkok local dates rather than assuming 90 days or UTC day-of-month.
  await sql`UPDATE app.barrier SET health = 'healthy' WHERE org_id = ${orgId} AND code IN ('right-of-way-patrol', 'excavation-permit-one-call')`.execute(database);
  await sql`UPDATE app.signal_dependency SET last_received_at = NULL, created_at = '2026-02-28T20:30:00Z'::timestamptz
    WHERE org_id = ${orgId} AND rule_id = ${rules[1].id}::uuid`.execute(database);
  assert.equal(await store.detectSilence(new Date("2026-05-28T20:30:00Z")), 0);
  assert.equal(await store.detectSilence(new Date("2026-05-31T20:30:00Z")), 0);
  assert.equal(await store.detectSilence(new Date("2026-05-31T20:30:00.001Z")), 2);

  // Repeat authenticated production boundary against the real transactional store, including queue retry.
  let failPublish = true;
  const runtime = { store, identity: { verify: async () => {} }, audience: "https://worker.example.test", pushEmail: "push@example.test", schedulerEmail: "scheduler@example.test",
    subscription: "projects/fixture/subscriptions/signals-local", orgId, environment: "local", simulatedOnly: true, close: async () => {},
    publish: async () => { if (failPublish) throw new Error("queue retry fixture"); } };
  app = buildApp(runtime);
  const wire = reading({ observedAt: "2026-10-13T05:00:00Z" });
  const body = { subscription: runtime.subscription, message: { messageId: "first-push", data: Buffer.from(JSON.stringify(wire)).toString("base64"), attributes: {
    environment: "local", orgId, schemaVersion: wire.schemaVersion, signalId: wire.id, simulated: "true", classification: wire.classification,
  } } };
  const inject = () => app.inject({ method: "POST", url: "/internal/pubsub/signals", headers: { authorization: "Bearer fixture" }, payload: body });
  assert.equal((await inject()).statusCode, 503);
  const proposalsBeforeRetry = await count("health_proposal"); failPublish = false; body.message.messageId = "new-pubsub-message-same-producer-id";
  assert.equal((await inject()).statusCode, 204); assert.equal(await count("health_proposal"), proposalsBeforeRetry);

  // Source checking and Evidence insertion use the same dependency lock order.
  const race = await Promise.allSettled([
    store.ingest(reading({ source: "mock-patrol", tag: "DL-01.encroachment.detected", value: 0, unit: "boolean", observedAt: "2026-10-13T06:00:00Z" })),
    store.detectSilence(new Date()),
  ]);
  assert.ok(race.every(({ status }) => status === "fulfilled"), "ingestion and source checks must not deadlock");
  const times = [];
  for (let index = 0; index < 40; index++) {
    const start = performance.now(); await store.ingest(reading({ value: 2, observedAt: new Date(Date.parse(base.observedAt) + (36000 + index) * 1000).toISOString() }));
    times.push(performance.now() - start);
  }
  times.sort((left, right) => left - right);
  console.log(`Local PostGIS periodic Signal ingestion (40 sequential samples): p50=${times[19].toFixed(2)}ms p95=${times[37].toFixed(2)}ms`);
  const plan = await sql`EXPLAIN (ANALYZE, BUFFERS) SELECT content FROM app.signal_receipt
    WHERE org_id = ${orgId} AND stream_key = (SELECT stream_key FROM app.signal_receipt WHERE org_id = ${orgId} LIMIT 1)
      AND observed_at >= '2026-10-13T00:00:00Z'::timestamptz ORDER BY observed_at`.execute(database);
  console.log(plan.rows.map((row) => row["QUERY PLAN"]).join("\n"));
  console.log("Worker PostGIS integration passed: concurrent producer deduplication, rollback, periodic CP/patrol, FL-78 rule fixtures, PR-47 source samples, durations, spatial boundary, receipt-clock silence, Failed-stays, audit, Organisation isolation and outbox retry.");
} finally {
  if (app) await app.close();
  if (application) await application.destroy();
  if (database) await database.destroy();
  try { docker("rm", "-f", container); } catch { /* Container may not have started. */ }
}
