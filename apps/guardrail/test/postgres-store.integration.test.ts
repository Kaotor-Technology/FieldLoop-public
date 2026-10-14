import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdempotencyKeyReusedError, type GuardrailPolicy, type GuardrailSystem, type RecordContentScanInput } from "../src/model.js";
import { PostgresGuardrailStore } from "../src/postgres-store.js";

const databaseUrl = process.env["FIELDLOOP_GUARDRAIL_TEST_DATABASE_URL"];
const integration = describe.skipIf(!databaseUrl);
let pool: Pool;
let store: PostgresGuardrailStore;

integration("PostgresGuardrailStore against migrated PostgreSQL", () => {
  beforeAll(() => {
    if (!databaseUrl) throw new Error("FIELDLOOP_GUARDRAIL_TEST_DATABASE_URL is required for Guardrail store integration tests");
    pool = new Pool({ connectionString: databaseUrl, max: 5 });
    store = new PostgresGuardrailStore(new Kysely<Record<string, never>>({ dialect: new PostgresDialect({ pool }) }));
  });

  afterAll(async () => { await pool?.end(); });

  it("records a two-Intercept content scan in one write and replays it by idempotency key", async () => {
    const { system, injection, routing } = await createFixture();
    const input: RecordContentScanInput = {
      system,
      idempotencyKeyHash: "a".repeat(64),
      requestHash: "b".repeat(64),
      records: [
        { system, policy: injection, decision: "allow", reason: "Tier 1 content scan completed", latencyMs: 12, classification: "CONFIDENTIAL" },
        { system, policy: routing, decision: "reroute", reason: "Sensitive data requires the configured private model tier", latencyMs: 13, classification: "CONFIDENTIAL" },
      ],
      result: { statusCode: 200, decision: "reroute", classification: "CONFIDENTIAL", reason: "Sensitive data requires the configured private model tier", policyId: routing.id },
      primaryRecordIndex: 1,
    };

    const stored = await store.recordContentScan(input);

    const intercepts = await pool.query<{ id: string; policy_id: string; decision: string; latency_ms: number }>(
      "SELECT id::text, policy_id::text, decision, latency_ms FROM app.intercept WHERE org_id = $1 ORDER BY latency_ms", [system.orgId]);
    expect(intercepts.rows.map((row) => [row.policy_id, row.decision, row.latency_ms])).toEqual([[injection.id, "allow", 12], [routing.id, "reroute", 13]]);
    expect(stored.interceptId).toBe(intercepts.rows[1]?.id);
    const evidence = await pool.query<{ barrier_id: string }>(
      "SELECT barrier_id::text FROM app.evidence WHERE org_id = $1 AND kind = 'guardrail.intercept' ORDER BY barrier_id", [system.orgId]);
    expect(evidence.rows.map((row) => row.barrier_id).sort()).toEqual([injection.barrierId, routing.barrierId].sort());
    const outbox = await pool.query<{ type: string; entity_id: string }>(
      "SELECT event->>'type' AS type, event->>'entityId' AS entity_id FROM app.signal_event_outbox WHERE org_id = $1", [system.orgId]);
    expect(outbox.rows).toHaveLength(2);
    expect(outbox.rows.every((row) => row.type === "evidence.created")).toBe(true);
    const request = await pool.query<{ intercept_id: string; policy_id: string }>(
      "SELECT intercept_id::text, policy_id::text FROM app.guardrail_content_request WHERE org_id = $1", [system.orgId]);
    expect(request.rows).toEqual([{ intercept_id: stored.interceptId, policy_id: routing.id }]);

    await expect(store.recordContentScan(input)).resolves.toEqual(stored);
    await expect(store.recordContentScan({ ...input, requestHash: "c".repeat(64) })).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
    expect((await pool.query("SELECT 1 FROM app.intercept WHERE org_id = $1", [system.orgId])).rowCount).toBe(2);
  });

  it("records a chat Intercept with its Evidence and outbox event", async () => {
    const { system, injection } = await createFixture();

    const interceptId = await store.recordIntercept({ system, policy: injection, decision: "block", reason: "Injection", latencyMs: 7, classification: "INTERNAL" });

    const intercept = await pool.query("SELECT 1 FROM app.intercept WHERE id = $1 AND decision = 'block'", [interceptId]);
    expect(intercept.rowCount).toBe(1);
    expect((await pool.query("SELECT 1 FROM app.evidence WHERE org_id = $1 AND barrier_id = $2", [system.orgId, injection.barrierId])).rowCount).toBe(1);
    expect((await pool.query("SELECT 1 FROM app.signal_event_outbox WHERE org_id = $1", [system.orgId])).rowCount).toBe(1);
  });
});

async function createFixture(): Promise<{ system: GuardrailSystem; injection: GuardrailPolicy; routing: GuardrailPolicy }> {
  const orgId = `guardrail-integration-${randomUUID()}`;
  const systemId = randomUUID();
  const policies = [policy("injection"), policy("classification-routing")] as const;
  for (const item of policies) {
    await pool.query(
      `INSERT INTO app.barrier (id, org_id, name, type, side, pfd_band, health, simulated, classification, created_by)
       VALUES ($1, $2, 'Synthetic Guardrail barrier', 'technical', 'preventive', 0.01, 'healthy', true, 'INTERNAL', 'synthetic-test')`,
      [item.barrierId, orgId],
    );
  }
  await pool.query(
    `INSERT INTO app.ai_system (id, org_id, name, simulated, classification, created_by)
     VALUES ($1, $2, 'SYNTHETIC AI System', true, 'INTERNAL', 'synthetic-test')`,
    [systemId, orgId],
  );
  for (const item of policies) {
    await pool.query(
      `INSERT INTO app.guardrail_policy (id, org_id, ai_system_id, barrier_id, tier, mode, fail_mode, simulated, classification, created_by)
       VALUES ($1, $2, $3, $4, 'tier1', 'enforce', 'closed', true, 'INTERNAL', 'synthetic-test')`,
      [item.id, orgId, systemId, item.barrierId],
    );
  }
  const system: GuardrailSystem = {
    id: systemId, code: "synthetic-ai-system", orgId, simulated: true, classification: "INTERNAL",
    dataClasses: ["INTERNAL", "CONFIDENTIAL"], modelRoutes: [], policies: [...policies],
  };
  return { system, injection: policies[0], routing: policies[1] };
}

function policy(kind: string): GuardrailPolicy {
  return { id: randomUUID(), code: `synthetic-${kind}`, barrierId: randomUUID(), kind, mode: "enforce", failMode: "closed", config: {} };
}
