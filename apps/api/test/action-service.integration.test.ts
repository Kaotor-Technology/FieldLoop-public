import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresHealthStore } from "../src/health/postgres-store.js";
import { Kysely, PostgresDialect } from "kysely";
import { PostgresActionStore, type ActionIdentity } from "@fieldloop/adapters";
import type { ActionRequestCreate, ToolCallCheck } from "@fieldloop/contracts";
const url = process.env["FIELDLOOP_ACTION_TEST_DATABASE_URL"];
const integration = describe.skipIf(!url);
let db: Kysely<Record<string, never>>;
let pool: Pool;
let store: PostgresActionStore;
integration("FL-87 real PostgreSQL actions and tool checks", () => {
  beforeAll(() => {
    if (!url) throw new Error("FIELDLOOP_ACTION_TEST_DATABASE_URL is required");
    pool = new Pool({ connectionString: url });
    db = new Kysely({ dialect: new PostgresDialect({ pool }) });
    store = new PostgresActionStore(db);
  });
  afterAll(async () => { await db.destroy(); });
  async function fixture() {
    const orgId = `synthetic-${randomUUID()}`, systemId = randomUUID(), policyId = randomUUID(), barrierId = randomUUID();
    const user: ActionIdentity = { sub: "synthetic-operator", orgId, roles: ["fieldloop.operator"], clearance: "HIGHLY_RESTRICTED" };
    await pool.query("INSERT INTO app.barrier (id,org_id,type,side,health,simulated,classification) VALUES ($1,$2,'technical','preventive','unverified',true,'INTERNAL')", [barrierId, orgId]);
    await pool.query("INSERT INTO app.ai_system (id,org_id,name,tools,data_classes,simulated,classification) VALUES ($1,$2,'Synthetic AI', $3::jsonb, $4::jsonb,true,'INTERNAL')", [systemId, orgId, JSON.stringify(["get_asset", "create_action_request"]), JSON.stringify(["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED"])]);
    await pool.query("INSERT INTO app.guardrail_policy (id,org_id,ai_system_id,barrier_id,config,mode,fail_mode,simulated,classification) VALUES ($1,$2,$3,$4,$5::jsonb,'enforce','fail-closed',true,'INTERNAL')", [policyId, orgId, systemId, barrierId, JSON.stringify({ aiSystemCode: "synthetic-ai", kind: "tool-call", settings: { allowedTools: ["get_asset", "create_action_request"] } })]);
    const body: ActionRequestCreate = { actionType: "system_of_record", actionLevel: "l1", target: "cmms", payload: { title: "Synthetic maintenance", details: { b: 2, a: 1 } }, rationale: "Prepare for human entry", citations: ["synthetic:procedure-1"], classification: "INTERNAL", simulated: true };
    const check: ToolCallCheck = { ...body, aiSystem: "synthetic-ai", tool: "create_action_request" };
    return { user, body, check, policyId, systemId, barrierId };
  }
  const key = () => randomUUID();
  it("creates database-hashed exact proposals, authenticated requester and idempotent concurrent replay", async () => {
    const { user, body } = await fixture(), idempotencyKey = key();
    const results = await Promise.all(Array.from({ length: 5 }, () => store.create(user, body, idempotencyKey)));
    expect(new Set(results.map(x => x.id)).size).toBe(1);
    const action = results[0]; if (!action) throw new Error("Missing Action Request");
    expect(action).toMatchObject({ ...body, requestedBy: user.sub, orgId: user.orgId, status: "open" });
    const hash = await pool.query("SELECT app.payload_sha256($1::jsonb) AS hash", [JSON.stringify(body.payload)]);
    expect(action.payloadHash).toBe(hash.rows[0].hash);
    expect((await store.create(user, { ...body, payload: { details: { a: 1, b: 2 }, title: "Synthetic maintenance" } }, idempotencyKey)).id).toBe(action.id);
    await expect(store.create(user, { ...body, payload: { title: "Changed" } }, idempotencyKey)).rejects.toThrow("idempotency_key_reused");
  });
  it("allows only registered reads, converts L1, holds L2 and records Intercepts/Evidence", async () => {
    const { user, check } = await fixture();
    const read = await store.check(user, { aiSystem: check.aiSystem, tool: "get_asset", target: "fieldloop", simulated: true, classification: "INTERNAL" }, key());
    expect(read.decision).toBe("allow");
    const converted = await store.check(user, check, key()); expect(converted.decision).toBe("convert_l1");
    expect(converted.actionRequest?.status).toBe("open"); expect(converted.heldRequestId).toBeUndefined();
    const held = await store.check(user, { ...check, actionType: "emergency_communication", actionLevel: "l2", target: "stakeholders" }, key());
    expect(held.decision).toBe("hold_l2"); expect(held.heldRequestId).toBeTruthy();
    const row = (await pool.query("SELECT * FROM app.held_request WHERE id=$1", [held.heldRequestId])).rows[0];
    expect(row.status).toBe("held"); expect(row.payload).toEqual(check.payload); expect(row.payload_hash).toBe(held.actionRequest?.payloadHash);
    expect(Number((await pool.query("SELECT count(*) FROM app.evidence WHERE org_id=$1 AND kind='guardrail.intercept'", [user.orgId])).rows[0].count)).toBe(3);
    expect(Number((await pool.query("SELECT count(*) FROM app.signal_event_outbox WHERE org_id=$1", [user.orgId])).rows[0].count)).toBe(3);
  });
  it("never executes or creates artifacts for L3, unknown write tools, spoofed targets or above ceilings", async () => {
    const { user, check } = await fixture();
    await expect(store.check(user, { ...check, actionLevel: "l3" } as unknown as ToolCallCheck, key())).rejects.toThrow("validation_failed");
    for (const body of [{ ...check, tool: "write_cmms" }, { ...check, actionLevel: "l2" as const }, { ...check, actionType: "internal_record" as const }]) {
      expect((await store.check(user, body, key())).decision).toBe("block");
    }
    expect(Number((await pool.query("SELECT count(*) FROM app.action_request WHERE org_id=$1", [user.orgId])).rows[0].count)).toBe(0);
  });
  it("respects lowered Organisation ceilings and rechecks changed policies on replay", async () => {
    const { user, check, body } = await fixture(), savedKey = key();
    expect((await store.check(user, check, savedKey)).decision).toBe("convert_l1");
    await pool.query("INSERT INTO app.action_ceiling (org_id,action_type,action_level,simulated,classification) VALUES ($1,'system_of_record','l0',true,'INTERNAL')", [user.orgId]);
    expect((await store.check(user, check, savedKey)).decision).toBe("block");
    await expect(store.create(user, body, key())).rejects.toThrow("above_action_ceiling");
    await expect(pool.query("UPDATE app.action_ceiling SET action_level='l2' WHERE org_id=$1", [user.orgId])).rejects.toThrow();
  });
  it("fails closed on missing, ambiguous or monitor-only policy and incomplete action metadata", async () => {
    const { user, check, policyId } = await fixture();
    await expect(store.check(user, { ...check, aiSystem: "unknown" }, key())).rejects.toThrow("tool_registry_unavailable");
    await expect(store.check(user, { aiSystem: check.aiSystem, tool: check.tool, target: check.target, actionType: "system_of_record", actionLevel: "l1", simulated: true, classification: "INTERNAL" }, key())).rejects.toThrow("action_metadata_required");
    await pool.query("UPDATE app.guardrail_policy SET mode='monitor' WHERE id=$1", [policyId]);
    await expect(store.check(user, check, key())).rejects.toThrow("tool_registry_unavailable");
  });
  it("isolates Organisation, requester, simulation and classification", async () => {
    const { user, body, check } = await fixture(); const action = await store.create(user, body, key());
    await expect(store.get({ ...user, orgId: "other-org" }, action.id)).rejects.toThrow("not_found");
    await expect(store.get({ ...user, clearance: "PUBLIC" }, action.id)).rejects.toThrow("forbidden");
    await expect(store.create({ ...user, roles: ["fieldloop.viewer"] }, body, key())).rejects.toThrow("forbidden");
    await expect(store.create(user, { ...body, simulated: false }, key())).rejects.toThrow("simulation_required");
    await expect(store.check({ ...user, orgId: "other-org" }, check, key())).rejects.toThrow("tool_registry_unavailable");
    await expect(store.check({ ...user, clearance: "PUBLIC" }, check, key())).rejects.toThrow("forbidden");
    const raised = await store.check(user, { ...check, classification: "PUBLIC" }, key());
    expect(raised.actionRequest?.classification).toBe("INTERNAL");
  });
  it("bounds expiry by the server SLA and rejects past deadlines", async () => {
    const { user, body } = await fixture();
    await expect(store.create(user, { ...body, expiresAt: "2000-01-01T00:00:00Z" }, key())).rejects.toThrow("invalid_expiry");
    await expect(store.create(user, { ...body, expiresAt: "2099-01-01T00:00:00Z" }, key())).rejects.toThrow("invalid_expiry");
    const action = await store.create(user, body, key());
    const timing = (await pool.query("SELECT extract(epoch FROM expires_at-created_at) AS seconds FROM app.action_request WHERE id=$1", [action.id])).rows[0];
    expect(Number(timing.seconds)).toBe(900);
    expect((await store.get(user, action.id)).target).toBe(body.target);
  });
  it("rejects and escalates Action/Held Requests once, never returns a stale held authorization", async () => {
    const { user, check } = await fixture(), savedKey = key();
    const input = { ...check, actionType: "emergency_communication" as const, actionLevel: "l2" as const, target: "stakeholders" as const, expiresAt: new Date(Date.now() + 500).toISOString() };
    const held = await store.check(user, input, savedKey);
    if (!held.actionRequest) throw new Error("Missing action");
    await new Promise(resolve => setTimeout(resolve, 550));
    await expect(pool.query("UPDATE app.action_request SET status='executed' WHERE id=$1", [held.actionRequest.id])).rejects.toThrow();
    await expect(pool.query("UPDATE app.held_request SET status='allowed' WHERE id=$1", [held.heldRequestId])).rejects.toThrow();
    expect(await store.expire(user.orgId, true)).toBe(1); expect(await store.expire(user.orgId, true)).toBe(0);
    expect((await store.get(user, held.actionRequest.id)).status).toBe("rejected");
    expect((await pool.query("SELECT status,rejection_reason FROM app.held_request WHERE id=$1", [held.heldRequestId])).rows[0]).toEqual({ status: "rejected", rejection_reason: "sla_expired" });
    expect(Number((await pool.query("SELECT count(*) FROM app.action_escalation WHERE org_id=$1", [user.orgId])).rows[0].count)).toBe(1);
    expect((await pool.query("SELECT channel,sandbox,recipient_ref FROM app.notification WHERE org_id=$1", [user.orgId])).rows[0]).toEqual({ channel: "in_app", sandbox: true, recipient_ref: "sandbox:ai-governance" });
    expect((await store.check(user, input, savedKey)).decision).toBe("block");
    const manager = { ...user, sub:"synthetic-manager", roles:["fieldloop.manager"], persona:"Integrity Engineer" as const, csrfToken:"synthetic", authTime:new Date() };
    await pool.query("INSERT INTO app.app_user (org_id,keycloak_sub,roles_snapshot) VALUES ($1,$2,'[\"fieldloop.manager\"]'::jsonb)", [user.orgId, manager.sub]);
    const notifications=new PostgresHealthStore(db);
    expect((await notifications.listNotifications(manager,undefined,50)).items).toHaveLength(1);
    expect((await notifications.listNotifications({ ...manager,roles:["fieldloop.viewer"] },undefined,50)).items).toHaveLength(0);
    expect((await notifications.listNotifications({ ...manager,clearance:"PUBLIC" },undefined,50)).items).toHaveLength(0);
  });
  it("uses T04 exact-payload approval triggers and voids a held authorization after an edit", async () => {
    const { user, check } = await fixture();
    const savedKey = key();
    const input = { ...check, actionType: "internal_record" as const, actionLevel: "l2" as const, target: "fieldloop" as const };
    const held = await store.check(user, input, savedKey);
    const action = held.actionRequest; if (!action) throw new Error("Missing action");
    await expect(pool.query("INSERT INTO app.approval (org_id,action_request_id,approver_sub,decision,payload_hash,auth_time,simulated,classification) VALUES ($1,$2,'synthetic-human','approved','wrong',now(),true,'INTERNAL')", [user.orgId, action.id])).rejects.toThrow();
    await pool.query("INSERT INTO app.approval (org_id,action_request_id,approver_sub,decision,payload_hash,auth_time,simulated,classification) VALUES ($1,$2,'synthetic-human','approved',$3,now(),true,'INTERNAL')", [user.orgId, action.id, action.payloadHash]);
    await pool.query("UPDATE app.action_request SET status='approved' WHERE id=$1", [action.id]);
    await pool.query("UPDATE app.action_request SET payload='{\"changed\":true}'::jsonb WHERE id=$1", [action.id]);
    expect((await store.check(user, input, savedKey)).decision).toBe("block");
    const changed = await store.get(user, action.id); expect(changed.status).toBe("open"); expect(changed.payloadHash).not.toBe(action.payloadHash);
    expect((await pool.query("SELECT voided_at FROM app.approval WHERE action_request_id=$1", [action.id])).rows[0].voided_at).toBeTruthy();
    expect((await pool.query("SELECT status,rejection_reason FROM app.held_request WHERE id=$1", [held.heldRequestId])).rows[0]).toEqual({ status: "rejected", rejection_reason: "payload_changed" });
  });
  it("retires simulation proposals and denies delayed replay after reset", async () => {
    const { user, body, check } = await fixture();
    const scenarioId = randomUUID(), runId = randomUUID(), savedKey = key();
    await pool.query("INSERT INTO app.scenario (id,org_id,file,simulated,classification) VALUES ($1,$2,'synthetic.json',true,'INTERNAL')", [scenarioId,user.orgId]);
    await pool.query("INSERT INTO app.simulation_run (id,org_id,scenario_id,state,simulated,classification) VALUES ($1,$2,$3,'paused',true,'INTERNAL')", [runId,user.orgId,scenarioId]);
    await pool.query("SELECT app.capture_simulation_baseline($1)", [user.orgId]);
    await pool.query("UPDATE app.simulation_workspace SET active_run_id=$1 WHERE org_id=$2", [runId,user.orgId]);
    await expect(store.create(user,body,key())).rejects.toThrow();
    const heldInput = { ...check,actionType:"internal_record" as const, actionLevel:"l2" as const,target:"fieldloop" as const,simulationRunId:runId };
    const held=await store.check(user,heldInput,savedKey);
    if (!held.actionRequest) throw new Error("Missing simulation action");
    await pool.query("SELECT app.restore_simulation_baseline($1)", [user.orgId]);
    await expect(store.get(user,held.actionRequest.id)).rejects.toThrow("not_found");
    await expect(store.check(user,heldInput,savedKey)).rejects.toThrow("simulation_scope_invalid");
    expect(await store.expire(user.orgId,true)).toBe(0);
    await expect(pool.query("UPDATE app.held_request SET status='allowed' WHERE id=$1", [held.heldRequestId])).rejects.toThrow();
  });
  it("serializes expiry behind a concurrent simulation reset without deadlocking", async () => {
    const { user,body }=await fixture();
    const scenarioId=randomUUID(),runId=randomUUID();
    await pool.query("INSERT INTO app.scenario (id,org_id,file,simulated,classification) VALUES ($1,$2,'synthetic.json',true,'INTERNAL')", [scenarioId,user.orgId]);
    await pool.query("INSERT INTO app.simulation_run (id,org_id,scenario_id,state,simulated,classification) VALUES ($1,$2,$3,'paused',true,'INTERNAL')", [runId,user.orgId,scenarioId]);
    await pool.query("SELECT app.capture_simulation_baseline($1)", [user.orgId]);
    await pool.query("UPDATE app.simulation_workspace SET active_run_id=$1 WHERE org_id=$2", [runId,user.orgId]);
    const action=await store.create(user,{ ...body,simulationRunId:runId },key());
    await pool.query("UPDATE app.action_request SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [action.id]);
    const resetClient=await pool.connect();
    let expiration: Promise<number> | undefined;
    try {
      await resetClient.query("BEGIN");
      await resetClient.query("SELECT org_id FROM app.simulation_workspace WHERE org_id=$1 FOR UPDATE", [user.orgId]);
      expiration=store.expire(user.orgId,true);
      await new Promise(resolve=>setTimeout(resolve,50));
      await resetClient.query("SELECT app.restore_simulation_baseline($1)", [user.orgId]);
      await resetClient.query("COMMIT");
      expect(await expiration).toBe(0);
    } finally {
      await resetClient.query("ROLLBACK"); resetClient.release();
      if (expiration) await expiration;
    }
  });
  it("rolls back proposals, holds and audit if persistence fails", async () => {
    const { user,check } = await fixture();
    // Inject a fixture-specific storage failure after Action insertion, preserving every FK.
    const ddl=(await pool.query("SELECT format('ALTER TABLE app.evidence ADD CONSTRAINT fl87_synthetic_failure CHECK (org_id <> %L)', $1::text) AS statement", [user.orgId])).rows[0].statement;
    await pool.query(ddl);
    try { await expect(store.check(user,check,key())).rejects.toThrow(); }
    finally { await pool.query("ALTER TABLE app.evidence DROP CONSTRAINT fl87_synthetic_failure"); }
    expect(Number((await pool.query("SELECT count(*) FROM app.action_request WHERE org_id=$1", [user.orgId])).rows[0].count)).toBe(0);
    expect(Number((await pool.query("SELECT count(*) FROM app.audit_event WHERE org_id=$1", [user.orgId])).rows[0].count)).toBe(0);
  });
  it("records local service timing and real query plans without a Cloud Run latency claim", async () => {
    const { user,check } = await fixture();
    const read = { aiSystem:check.aiSystem,tool:"get_asset",target:"fieldloop" as const,simulated:true,classification:"INTERNAL" as const };
    const durations: number[]=[];
    for (let i=0;i<50;i++) { const started=performance.now(); await store.check(user,read,key()); durations.push(performance.now()-started); }
    durations.sort((a,b)=>a-b);
    console.info(JSON.stringify({ measurement:"local PostgreSQL tool-check service; no HTTP/TLS",n:durations.length,p50Ms:durations[24],p95Ms:durations[47] }));
    const plan=await pool.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT id FROM app.action_request WHERE org_id=$1 AND status IN ('open','in_review','awaiting_second','approved') AND expires_at <= clock_timestamp() AND simulation_retired_at IS NULL", [user.orgId]);
    console.info(JSON.stringify({ measurement:"action expiry candidate query plan",plan:plan.rows[0] }));
  });

});
