import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { domainPackRecordId, loadDemoDomainPacks } from "../apps/api/dist/domain-packs.js";
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
const loadedPacks = await loadDemoDomainPacks();
const pr47Signals = JSON.parse(readFileSync("apps/signal-worker/test/fixtures/pr47-signals.json", "utf8"));
const rules = loadedPacks.flatMap(({ content }) => content.signalRules
  .filter((rule) => rule.condition.kind === "signal")
  .map((rule) => ({ pack: content.id,
    id: domainPackRecordId(orgId, content.id, "signal_rule", rule.id),
    condition: { ...rule.condition, ruleId: rule.id, packVersion: content.version, effect: rule.effect },
    selector: rule.targetBarrierSelector })));
const cpRule = rules.find(({ condition }) => condition.ruleId === "cp-rectifier-output-lost");
const patrolRule = rules.find(({ condition }) => condition.ruleId === "encroachment-detected");
assert.ok(cpRule && patrolRule, "loaded FL-78 packs must include the CP and patrol Signal rules");
const continuousRule = { ...cpRule, id: randomUUID(), condition: { ...cpRule.condition,
  source: "mock-continuous", tag: "DL-01.rectifier.output.continuous", ruleId: "fixture-continuous-cp-zero",
  durationSeconds: 120, expectedIntervalSeconds: 60 } };
// Persist the actual FL-78 pack-loader output, not a hand-copied rule snapshot.
// The merged PR #47 source snapshot 4a35cea00bc0a4571d85bdc5525a8cf110f6ec46 emits a rain
// rate plus a separate 24-hour aggregate, and a pump Signal matching the pack's exact tag and unit.
const intervals = { "mock-historian": { months: 3 }, "mock-patrol": { months: 3 }, "mock-hydro": 60, "mock-pumps": 60, "mock-continuous": 60 };
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
      await sql`INSERT INTO app.signal_rule (id, org_id, pack, condition, target_barrier_selector, simulated, classification, created_by)
        VALUES (${org === orgId ? rule.id : randomUUID()}::uuid, ${org}, ${rule.pack}, ${JSON.stringify(rule.condition)}::jsonb, ${JSON.stringify(rule.selector)}::jsonb,
          true, 'CONFIDENTIAL', 'worker-fixture')`.execute(database);
    }
    if (org === orgId) {
      await sql`INSERT INTO app.signal_rule (id, org_id, pack, condition, target_barrier_selector, simulated, classification, created_by)
        VALUES (${continuousRule.id}::uuid, ${org}, ${continuousRule.pack}, ${JSON.stringify(continuousRule.condition)}::jsonb,
          ${JSON.stringify(continuousRule.selector)}::jsonb, true, 'CONFIDENTIAL', 'worker-fixture')`.execute(database);
    }
  }
  const store = new PostgresWorkerStore(application, orgId, intervals);
  await store.initialize(); await store.initialize();
  assert.equal(await count("signal_dependency"), 8);
  const healthBefore = await snapshot();
  const cpBarrierBefore = (await sql`SELECT id, health FROM app.barrier WHERE org_id = ${orgId} AND code = 'cathodic-protection'`.execute(database)).rows[0];
  assert.ok(cpBarrierBefore, "the seeded DL-01 CP Barrier must exist");
  const otherHealthBefore = (await sql`SELECT id, health FROM app.barrier WHERE org_id = ${otherOrg} ORDER BY id`.execute(database)).rows;
  await assert.rejects(sql`SELECT access_token FROM app.user_session LIMIT 1`.execute(application), /permission denied/);
  await assert.rejects(sql`UPDATE app.audit_event SET action = 'forged' WHERE false`.execute(application), /permission denied/);
  const first = reading();
  await Promise.all(Array.from({ length: 10 }, () => store.ingest(first)));
  assert.equal(await count("signal"), 1); assert.equal(await count("signal_receipt"), 1);
  assert.equal(await count("health_proposal"), 1); assert.equal(await count("evidence", sql`AND signal_receipt_id IS NOT NULL`), 1);
  const cpProposal = (await sql`SELECT p.proposed_health AS "proposedHealth", p.status, b.health AS "barrierHealth"
    FROM app.health_proposal p JOIN app.barrier b ON b.id = p.barrier_id AND b.org_id = p.org_id
    WHERE p.org_id = ${orgId} AND p.signal_receipt_id = ${first.id}::uuid`.execute(database)).rows[0];
  assert.ok(cpProposal, "the pack's CP rule must create a proposal for the CP Barrier");
  assert.equal(cpProposal.proposedHealth, cpRule.condition.effect.proposedHealth);
  assert.equal(cpProposal.proposedHealth, "failed", "the current FL-78 CP pack effect is Failed");
  assert.equal(cpProposal.status, "open");
  assert.equal(cpProposal.barrierHealth, cpBarrierBefore.health, "a Signal proposal never applies Health");
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
  await store.ingest(reading({ source: "mock-pumps", tag: "pump.power", value: "lost", unit: "state" }));
  assert.equal(await count("health_proposal"), 7);
  assert.deepEqual(await snapshot(), healthBefore);

  // Independent source fields from PR #47's Observation + SimulatedSignalEmitter, not signal-cases.json.
  // The rate does not imply a 24-hour total; the source separately publishes that aggregate.
  const sourceRun = randomUUID();
  const sourceReading = (sample, observedAt) => reading({ ...sample, id: randomUUID(), orgId,
    simulationRunId: sourceRun, observedAt });
  const rainRateSourceSample = sourceReading(pr47Signals.rainRate, "2026-10-13T00:02:00Z");
  const rainAccumulationSourceSample = sourceReading(pr47Signals.rainAccumulation, "2026-10-13T00:02:01Z");
  const pumpSourceSample = sourceReading(pr47Signals.pump, "2026-10-13T00:03:00Z");
  const proposalsBeforeSourceSamples = await count("health_proposal");
  const evidenceBeforeSourceSamples = await count("evidence", sql`AND signal_receipt_id IS NOT NULL`);
  await store.ingest(rainRateSourceSample);
  await store.ingest(rainAccumulationSourceSample);
  await store.ingest(pumpSourceSample);
  const sourceSignalIds = [rainRateSourceSample.id, rainAccumulationSourceSample.id, pumpSourceSample.id];
  const sourceSignalIdList = sql.join(sourceSignalIds.map((id) => sql`${id}::uuid`));
  assert.equal(await count("signal_receipt", sql`AND id IN (${sourceSignalIdList})`), 3);
  assert.equal(await count("health_proposal", sql`AND signal_receipt_id IN (${sourceSignalIdList})`), 4,
    "the 24-hour aggregate and pump source Signals create proposals through the loaded pack rules");
  assert.equal(await count("evidence", sql`AND signal_receipt_id IN (${sourceSignalIdList})`), 4);
  assert.equal(await count("health_proposal", sql`AND signal_receipt_id = ${rainRateSourceSample.id}::uuid`), 0,
    "a rain rate alone is not a 24-hour aggregate");
  assert.equal(await count("health_proposal"), proposalsBeforeSourceSamples + 4);
  assert.equal(await count("evidence", sql`AND signal_receipt_id IS NOT NULL`), evidenceBeforeSourceSamples + 4);
  const proposalsAfterSourceSamples = await count("health_proposal");

  // CP's configured quarterly interval cannot be overridden by a rule-level seconds interval.
  await sql`UPDATE app.signal_rule SET condition = condition || '{"durationSeconds":120,"expectedIntervalSeconds":60}'::jsonb WHERE id = ${cpRule.id}::uuid`.execute(database);
  const periodicOverride = reading({ observedAt: "2026-10-13T00:04:00Z" });
  const signalCountBeforeOverride = await count("signal");
  await assert.rejects(store.ingest(periodicOverride), /cannot override the configured calendar measurement interval/);
  assert.equal(await count("signal"), signalCountBeforeOverride);
  assert.equal(await count("signal_receipt", sql`AND id = ${periodicOverride.id}::uuid`), 0);
  await sql`UPDATE app.signal_rule SET condition = condition - 'durationSeconds' - 'expectedIntervalSeconds' WHERE id = ${cpRule.id}::uuid`.execute(database);

  // Strict duration runs on a separately configured continuous source; sparse samples fail.
  const run = randomUUID();
  const continuousReading = (simulationRunId, seconds) => reading({ source: "mock-continuous", tag: "DL-01.rectifier.output.continuous",
    simulationRunId, observedAt: new Date(Date.parse(base.observedAt) + (600 + seconds) * 1000).toISOString() });
  for (const seconds of [0, 60, 120, 121]) await store.ingest(continuousReading(run, seconds));
  assert.equal(await count("health_proposal"), proposalsAfterSourceSamples + 1);
  const sparseRun = randomUUID();
  for (const seconds of [0, 180]) await store.ingest(continuousReading(sparseRun, 1000 + seconds));
  assert.equal(await count("health_proposal"), proposalsAfterSourceSamples + 1);

  // Spatial rule: boundary covered, outside/missing/invalid location do not match.
  await sql`UPDATE app.signal_rule SET spatial_geom = ST_MakeEnvelope(100, 13, 101, 14, 4326) WHERE id = ${cpRule.id}::uuid`.execute(database);
  for (const payload of [{}, { location: { type: "Point", coordinates: [102, 13.5] } }, { location: { type: "Point", coordinates: [999, 13.5] } }]) {
    await store.ingest(reading({ observedAt: "2026-10-13T01:00:00Z", payload }));
  }
  assert.equal(await count("health_proposal"), proposalsAfterSourceSamples + 1);
  await store.ingest(reading({ observedAt: "2026-10-13T01:00:01Z", payload: { location: { type: "Point", coordinates: [100, 13.5] } } }));
  assert.equal(await count("health_proposal"), proposalsAfterSourceSamples + 2);
  await sql`UPDATE app.signal_rule SET spatial_geom = NULL WHERE id = ${cpRule.id}::uuid`.execute(database);

  await store.ingest(reading({ simulationRunId: randomUUID(), observedAt: base.observedAt }));
  assert.equal(await count("health_proposal"), proposalsAfterSourceSamples + 3, "a new Scenario run must not inherit the previous run's observation watermark");

  // Transaction rollback after a later failure must remove receipt, Signal and Evidence as well.
  await sql`ALTER TABLE app.health_proposal ADD CONSTRAINT fixture_proposal_failure CHECK (reason <> 'rollback fixture') NOT VALID`.execute(database);
  await sql`UPDATE app.signal_rule SET condition = jsonb_set(condition, '{effect,reason}', '"rollback fixture"') WHERE id = ${cpRule.id}::uuid`.execute(database);
  const beforeRollback = await count("signal"), rejected = reading({ observedAt: "2026-10-13T02:00:00Z" });
  await assert.rejects(store.ingest(rejected), /fixture_proposal_failure/);
  assert.equal(await count("signal"), beforeRollback); assert.equal(await count("signal_receipt", sql`AND id = ${rejected.id}::uuid`), 0);
  await sql`ALTER TABLE app.health_proposal DROP CONSTRAINT fixture_proposal_failure`.execute(database);
  await sql`UPDATE app.signal_rule SET condition = jsonb_set(condition, '{effect,reason}', '"SIMULATION periodic reading"') WHERE id = ${cpRule.id}::uuid`.execute(database);

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
  const patrolBarrierCodes = ["right-of-way-patrol", "excavation-permit-one-call"];
  await sql`UPDATE app.barrier SET health = 'healthy' WHERE org_id = ${orgId} AND code IN (${sql.join(patrolBarrierCodes)})`.execute(database);
  await sql`UPDATE app.signal_dependency SET last_received_at = NULL, created_at = '2026-02-28T20:30:00Z'::timestamptz
    WHERE org_id = ${orgId} AND rule_id = ${patrolRule.id}::uuid`.execute(database);
  assert.equal(await store.detectSilence(new Date("2026-05-28T20:30:00Z")), 0);
  assert.equal(await store.detectSilence(new Date("2026-05-31T20:30:00Z")), 0);
  assert.equal(await store.detectSilence(new Date("2026-05-31T20:30:00.001Z")), 2);

  // Repeat authenticated production boundary against the real transactional store, including queue retry.
  let failPublish = true;
  const publishedEvents = [];
  const runtime = { store, identity: { verify: async () => {} }, audience: "https://worker.example.test", pushEmail: "push@example.test", schedulerEmail: "scheduler@example.test",
    subscription: "projects/fixture/subscriptions/signals-local", orgId, environment: "local", simulatedOnly: true, close: async () => {},
    publish: async (event) => { if (failPublish) throw new Error("queue retry fixture"); publishedEvents.push(event); } };
  app = buildApp(runtime);
  const pushBody = (signal, messageId) => ({ subscription: runtime.subscription, message: { messageId, data: Buffer.from(JSON.stringify(signal)).toString("base64"), attributes: {
    environment: "local", orgId, schemaVersion: signal.schemaVersion, signalId: signal.id, simulated: "true", classification: signal.classification,
  } } });
  const serviceHeaders = { authorization: "Bearer fixture" };
  const postSignal = (payload, headers = serviceHeaders) => app.inject({ method: "POST", url: "/internal/pubsub/signals", headers, payload });
  const wire = reading({ observedAt: "2026-10-13T05:00:00Z" });
  const body = pushBody(wire, "first-push");
  const inject = () => postSignal(body);
  assert.equal((await inject()).statusCode, 503);
  const proposalsBeforeRetry = await count("health_proposal"); failPublish = false; body.message.messageId = "new-pubsub-message-same-producer-id";
  assert.equal((await inject()).statusCode, 204); assert.equal(await count("health_proposal"), proposalsBeforeRetry);

  // FL-27 / D08 (LS-1..LS-4) acceptance through the HTTP boundary with the real transactional store.
  // The CP Barrier starts Healthy so an auto-applied proposal (the pack effect is Failed) would be visible.
  await sql`UPDATE app.barrier SET health = 'healthy' WHERE org_id = ${orgId} AND code = 'cathodic-protection'`.execute(database);
  const periodicCpReading = reading({ observedAt: "2026-10-13T05:30:00Z" });
  const healthBeforePush = await snapshot();
  const signalsBeforePush = await count("signal"), receiptsBeforePush = await count("signal_receipt");
  const unauthenticatedResponse = await postSignal(pushBody(periodicCpReading, "no-token"), {});
  assert.equal(unauthenticatedResponse.statusCode, 401, "push without an OIDC token is rejected");
  assert.match(String(unauthenticatedResponse.headers["content-type"]), /application\/problem\+json/);
  assert.equal(await count("signal"), signalsBeforePush, "an unauthenticated push stores nothing");
  assert.equal(await count("signal_receipt"), receiptsBeforePush);
  assert.equal((await postSignal(pushBody(periodicCpReading, "first-delivery"))).statusCode, 204);
  assert.equal(await count("signal"), signalsBeforePush + 1, "the authenticated push stores the Signal");
  assert.equal(await count("signal_receipt"), receiptsBeforePush + 1);
  const proposalRows = (await sql`SELECT id, status, proposed_health AS "proposedHealth", barrier_id AS "barrierId"
    FROM app.health_proposal WHERE org_id = ${orgId} AND signal_receipt_id = ${periodicCpReading.id}::uuid`.execute(database)).rows;
  assert.equal(proposalRows.length, 1, "a qualifying push creates one Health Proposal");
  const [pushProposal] = proposalRows;
  assert.equal(pushProposal.status, "open");
  assert.equal(pushProposal.proposedHealth, cpRule.condition.effect.proposedHealth, "the proposal uses the registered pack effect");
  assert.equal(pushProposal.proposedHealth, "failed");
  assert.equal(pushProposal.barrierId, cpBarrierBefore.id, "the proposal targets the CP Barrier");
  assert.equal(await count("evidence", sql`AND signal_receipt_id = ${periodicCpReading.id}::uuid`), 1, "the push stores Evidence");
  const createdEvents = () => publishedEvents.filter(({ type, entityId }) => type === "health_proposal.created" && entityId === pushProposal.id);
  assert.equal(createdEvents().length, 1, "health_proposal.created is published once");
  assert.equal(createdEvents()[0].barrierId, pushProposal.barrierId);
  assert.equal(createdEvents()[0].simulated, true);
  for (const messageId of ["first-delivery", "redelivery-with-new-message-id"]) {
    assert.equal((await postSignal(pushBody(periodicCpReading, messageId))).statusCode, 204);
  }
  assert.equal(await count("health_proposal", sql`AND signal_receipt_id = ${periodicCpReading.id}::uuid`), 1, "redelivery stays idempotent");
  assert.equal(await count("evidence", sql`AND signal_receipt_id = ${periodicCpReading.id}::uuid`), 1);
  assert.equal(await count("signal"), signalsBeforePush + 1);
  assert.equal(createdEvents().length, 1, "redelivery publishes no second event");
  assert.deepEqual(await snapshot(), healthBeforePush, "an unaccepted Health Proposal leaves Barrier Health unchanged");
  assert.equal((await sql`SELECT health FROM app.barrier WHERE id = ${cpBarrierBefore.id}::uuid`.execute(database)).rows[0].health, "healthy");

  // A silent source marks its dependent Barriers Unverified through the Scheduler route; Failed stays Failed
  // even when its own source is also silent.
  const runSourceCheck = (headers) => app.inject({ method: "POST", url: "/internal/jobs/silent-sources", headers });
  assert.equal((await runSourceCheck({})).statusCode, 401, "the source check requires a service token");
  const barrierIdsFor = async (codes) => (await sql`SELECT id FROM app.barrier WHERE org_id = ${orgId}
    AND code IN (${sql.join(codes)})`.execute(database)).rows.map(({ id }) => id).sort();
  const floodBarrierCode = "tidal-gates";
  const silentBarrierCodes = [...patrolBarrierCodes, floodBarrierCode];
  const silentBarrierIds = await barrierIdsFor(silentBarrierCodes);
  const [floodBarrierId] = await barrierIdsFor([floodBarrierCode]);
  assert.equal(silentBarrierIds.length, silentBarrierCodes.length);
  const silentCodeList = sql.join(silentBarrierCodes);
  await sql`UPDATE app.barrier SET health = 'healthy' WHERE org_id = ${orgId} AND code IN (${silentCodeList})`.execute(database);
  await sql`UPDATE app.barrier SET health = 'failed' WHERE org_id = ${orgId} AND code = 'cathodic-protection'`.execute(database);
  // Back-date the patrol, CP and flood-rain sources by 270 days; silence is induced in SQL, not by waiting.
  // pumping-stations and water-gates were already made Unverified by the earlier deadline checks, so they emit no event.
  const aged = await sql`UPDATE app.signal_dependency SET last_received_at = ${new Date(Date.now() - 270 * 86_400_000)}
    WHERE org_id = ${orgId} AND (rule_id IN (${patrolRule.id}::uuid, ${cpRule.id}::uuid) OR barrier_id = ${floodBarrierId}::uuid)
    RETURNING id`.execute(database);
  const cpAndFloodDependencies = 2; // the CP rule's and tidal-gates' rain-rule dependency
  assert.equal(aged.rows.length, patrolBarrierCodes.length + cpAndFloodDependencies, "patrol, CP and flood-rain dependencies are aged");
  const healthChangedSince = (index) => publishedEvents.slice(index).filter(({ type }) => type === "barrier.health_changed");
  const eventsBeforeCheck = publishedEvents.length;
  const sourceCheck = await runSourceCheck(serviceHeaders);
  assert.equal(sourceCheck.statusCode, 200);
  const healthChangedEvents = healthChangedSince(eventsBeforeCheck);
  assert.deepEqual(healthChangedEvents.map(({ barrierId }) => barrierId).sort(), silentBarrierIds, "Healthy Barriers with an aged source become Unverified; Failed and already-Unverified Barriers do not change");
  assert.equal(sourceCheck.json().changed, healthChangedEvents.length);
  assert.deepEqual((await sql`SELECT code, health FROM app.barrier WHERE org_id = ${orgId}
    AND code IN (${silentCodeList}, 'cathodic-protection') ORDER BY code`.execute(database)).rows, [
    { code: "cathodic-protection", health: "failed" },
    { code: "excavation-permit-one-call", health: "unverified" },
    { code: "right-of-way-patrol", health: "unverified" },
    { code: "tidal-gates", health: "unverified" },
  ]);

  // Control: the same Barrier, Healthy again with a source that reported just now, must not change.
  await sql`UPDATE app.barrier SET health = 'healthy' WHERE id = ${floodBarrierId}::uuid`.execute(database);
  const refreshed = await sql`UPDATE app.signal_dependency SET last_received_at = ${new Date()}
    WHERE org_id = ${orgId} AND barrier_id = ${floodBarrierId}::uuid RETURNING id`.execute(database);
  assert.equal(refreshed.rows.length, 1, "the control Barrier has exactly one source dependency");
  const eventsBeforeControl = publishedEvents.length;
  const controlCheck = await runSourceCheck(serviceHeaders);
  assert.equal(controlCheck.statusCode, 200);
  assert.equal(controlCheck.json().changed, 0, "a fresh source changes nothing");
  assert.deepEqual(healthChangedSince(eventsBeforeControl), []);
  assert.equal((await sql`SELECT health FROM app.barrier WHERE id = ${floodBarrierId}::uuid`.execute(database)).rows[0].health, "healthy");

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
  console.log("Worker PostGIS integration passed: concurrent producer deduplication, rollback, periodic CP/patrol, FL-78 loaded pack rules, PR-47 source samples, durations, spatial boundary, receipt-clock silence, Failed-stays, audit, Organisation isolation, outbox retry and FL-27 HTTP acceptance.");
} finally {
  if (app) await app.close();
  if (application) await application.destroy();
  if (database) await database.destroy();
  try { docker("rm", "-f", container); } catch { /* Container may not have started. */ }
}
