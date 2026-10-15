import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { loadDemoDomainPacks, registerDomainPackRecords } from "../src/domain-packs.js";
import { PostgresHealthStore } from "../src/health/postgres-store.js";
import { Kysely, PostgresDialect } from "kysely";
import { PostgresActionStore, type ActionIdentity, type ApproverIdentity } from "@fieldloop/adapters";
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
    await pool.query("INSERT INTO app.guardrail_policy (id,org_id,ai_system_id,barrier_id,config,mode,fail_mode,simulated,classification) VALUES ($1,$2,$3,$4,$5::jsonb,'enforce','fail-closed',true,'INTERNAL')", [policyId, orgId, systemId, barrierId, JSON.stringify({ aiSystemCode: "synthetic-ai", kind: "tool-call", settings: { allowedTools: ["get_asset", "create_action_request"], allowedTargets: ["fieldloop", "cmms", "stakeholders"] } })]);
    const body: ActionRequestCreate = { actionType: "system_of_record", actionLevel: "l1", target: "cmms", payload: { title: "Synthetic maintenance", details: { b: 2, a: 1 } }, rationale: "Prepare for human entry", citations: ["synthetic:procedure-1"], classification: "INTERNAL", simulated: true };
    const check: ToolCallCheck = { ...body, aiSystem: "synthetic-ai", tool: "create_action_request" };
    return { user, body, check, policyId, systemId, barrierId };
  }
  const key = () => randomUUID();
  it("registers the UC-4 Guardrail with independent IDs, private routes and unchanged source classification", async () => {
    const orgId = `synthetic-${randomUUID()}`;
    const packs = await loadDemoDomainPacks();
    const flood = packs.find(p => p.content.id === "flood-water");
    expect(flood?.aiSafety?.aiSystem.id).toBe("demo-uc-4");
    expect(flood?.aiSafety?.aiSystem.tools).toContain("prepare_public_warning");
    expect(flood?.aiSafety?.classification).toBe("CONFIDENTIAL");
    expect(flood?.aiSafety?.aiSystem.modelRoutes.some(r => r.tier === "public-saas" && r.enabled)).toBe(false);
    await registerDomainPackRecords(db, orgId, packs);
    const systems = (await pool.query("SELECT id,classification,tools FROM app.ai_system WHERE org_id=$1 ORDER BY id",[orgId])).rows;
    expect(systems).toHaveLength(2);
    expect(systems.every(r=>r.classification === "CONFIDENTIAL")).toBe(true);
    const policy = (await pool.query("SELECT config FROM app.guardrail_policy WHERE org_id=$1 AND config->>'aiSystemCode'='demo-uc-4' AND config->>'kind'='tool-call'",[orgId])).rows[0].config;
    expect(policy.settings.allowedTools).toEqual(flood?.agents[0]?.allowedTools);
    expect(policy.settings.allowedTargets).toEqual(["fieldloop", "stakeholders"]);
    await registerDomainPackRecords(db, orgId, packs);
    expect((await pool.query("SELECT id,classification,tools FROM app.ai_system WHERE org_id=$1 ORDER BY id",[orgId])).rows).toEqual(systems);
    expect((await pool.query("SELECT count(*)::int AS n FROM app.signal_rule WHERE org_id=$1 AND pack='flood-water'",[orgId])).rows[0].n).toBe(2);
  });
  it("holds an independent Public template while retaining classified registry and source trace", async () => {
    const { user, check, systemId, policyId } = await fixture();
    const tools = ["create_action_request", "prepare_public_warning"];
    await pool.query("UPDATE app.ai_system SET classification='CONFIDENTIAL',tools=$2::jsonb WHERE id=$1", [systemId, JSON.stringify(tools)]);
    await pool.query("UPDATE app.guardrail_policy SET config=jsonb_set(config,'{settings,allowedTools}',$2::jsonb) WHERE id=$1", [policyId, JSON.stringify(tools)]);
    const scenarioId = randomUUID(), runId = randomUUID();
    await pool.query("INSERT INTO app.scenario (id,org_id,file,simulated,classification) VALUES ($1,$2,'synthetic.json',true,'CONFIDENTIAL')", [scenarioId,user.orgId]);
    await pool.query("INSERT INTO app.simulation_run (id,org_id,scenario_id,state,simulated,classification) VALUES ($1,$2,$3,'paused',true,'CONFIDENTIAL')", [runId,user.orgId,scenarioId]);
    await pool.query("SELECT app.capture_simulation_baseline($1)", [user.orgId]);
    await pool.query("UPDATE app.simulation_workspace SET active_run_id=$1 WHERE org_id=$2", [runId,user.orgId]);
    const validate = vi.fn(async () => {});
    const guarded = new PostgresActionStore(db, true, { validate });
    const input: ToolCallCheck = { ...check, classification: "CONFIDENTIAL", simulationRunId: runId,
      tool: "prepare_public_warning", actionType: "emergency_communication", actionLevel: "l2", target: "stakeholders",
      payload: { templateId: "district-z3-exercise-v1", channels: ["telegram", "discord"], recipientRefs: ["sandbox:district-z3"] },
      rationale: "CONFIDENTIAL caller rationale must not enter the Public artifact", citations: ["confidential:source"] };
    await expect(store.check(user,input,key())).rejects.toThrow("notifications_unavailable");
    const held = await guarded.check(user,input,key());
    expect(held.decision).toBe("hold_l2");
    expect(held.actionRequest?.classification).toBe("PUBLIC");
    expect(held.actionRequest?.requester).toEqual({ kind: "assistant", aiSystemId: systemId });
    expect(JSON.stringify(held.actionRequest)).not.toContain("confidential:source");
    expect(JSON.stringify(held.actionRequest)).not.toContain("caller rationale");
    expect(validate).toHaveBeenCalledOnce();
    const traces = (await pool.query("SELECT classification,reason FROM app.intercept WHERE org_id=$1 ORDER BY classification", [user.orgId])).rows;
    expect(traces).toEqual([{classification:"CONFIDENTIAL",reason:"human_action_required"},{classification:"PUBLIC",reason:"authored_public_template"}]);
    expect((await pool.query("SELECT classification FROM app.ai_system WHERE id=$1", [systemId])).rows[0].classification).toBe("CONFIDENTIAL");
    await expect(guarded.check(user,{...input,payload:{...input.payload,message:"secret"}},key())).rejects.toThrow("invalid_public_warning_selection");
    validate.mockRejectedValueOnce(new Error("no_enabled_notification_channel"));
    await expect(guarded.check(user,input,key())).rejects.toThrow("no_enabled_notification_channel");
    expect((await pool.query("SELECT count(*)::int AS n FROM app.action_request WHERE org_id=$1",[user.orgId])).rows[0].n).toBe(1);
  });
  it("creates database-hashed exact proposals, authenticated requester and idempotent concurrent replay", async () => {
    const { user, body } = await fixture(), idempotencyKey = key();
    const results = await Promise.all(Array.from({ length: 5 }, () => store.create(user, body, idempotencyKey)));
    expect(new Set(results.map(x => x.id)).size).toBe(1);
    const action = results[0]; if (!action) throw new Error("Missing Action Request");
    expect(action).toMatchObject({ ...body, requestedBy: user.sub, requester: { kind: "person" }, orgId: user.orgId, status: "open" });
    const hash = await pool.query("SELECT app.payload_sha256($1::jsonb) AS hash", [JSON.stringify(body.payload)]);
    expect(action.payloadHash).toBe(hash.rows[0].hash);
    expect((await store.create(user, { ...body, payload: { details: { a: 1, b: 2 }, title: "Synthetic maintenance" } }, idempotencyKey)).id).toBe(action.id);
    await expect(store.create(user, { ...body, payload: { title: "Changed" } }, idempotencyKey)).rejects.toThrow("idempotency_key_reused");
  });
  it("allows only registered reads, converts L1, holds L2 and records Intercepts/Evidence", async () => {
    const { user, check, systemId } = await fixture();
    const read = await store.check(user, { aiSystem: check.aiSystem, tool: "get_asset", target: "fieldloop", simulated: true, classification: "INTERNAL" }, key());
    expect(read.decision).toBe("allow");
    const converted = await store.check(user, check, key()); expect(converted.decision).toBe("convert_l1");
    expect(converted.actionRequest?.status).toBe("open"); expect(converted.heldRequestId).toBeUndefined();
    // PRD AX-1: a converted tool call names the assistant, on behalf of the session user.
    expect(converted.actionRequest).toMatchObject({ requestedBy: user.sub, requester: { kind: "assistant", aiSystemId: systemId } });
    const held = await store.check(user, { ...check, actionType: "emergency_communication", actionLevel: "l2", target: "stakeholders" }, key());
    expect(held.decision).toBe("hold_l2"); expect(held.heldRequestId).toBeTruthy();
    expect(held.actionRequest?.requester).toEqual({ kind: "assistant", aiSystemId: systemId });
    const row = (await pool.query("SELECT * FROM app.held_request WHERE id=$1", [held.heldRequestId])).rows[0];
    expect(row.status).toBe("held"); expect(row.payload).toEqual(check.payload); expect(row.payload_hash).toBe(held.actionRequest?.payloadHash);
    expect(Number((await pool.query("SELECT count(*) FROM app.evidence WHERE org_id=$1 AND kind='guardrail.intercept'", [user.orgId])).rows[0].count)).toBe(3);
    expect(Number((await pool.query("SELECT count(*) FROM app.signal_event_outbox WHERE org_id=$1", [user.orgId])).rows[0].count)).toBe(5);
    const actionEvents = await pool.query<{ status: string }>("SELECT event->>'status' AS status FROM app.signal_event_outbox WHERE org_id=$1 AND event->>'type'='action_request.updated' ORDER BY created_at, id", [user.orgId]);
    expect(actionEvents.rows.map(({ status }) => status)).toEqual(["open", "open"]);
  });
  it("never executes or creates artifacts for L3, unknown write tools, spoofed targets or above ceilings", async () => {
    const { user, check, policyId } = await fixture();
    await expect(store.check(user, { ...check, actionLevel: "l3" } as unknown as ToolCallCheck, key())).rejects.toThrow("validation_failed");
    for (const body of [{ ...check, tool: "write_cmms" }, { ...check, actionLevel: "l2" as const }, { ...check, actionType: "internal_record" as const }]) {
      expect((await store.check(user, body, key())).decision).toBe("block");
    }
    // PRD GR-4: GIS is a valid system-of-record target but is not on this AI System's target allowlist.
    expect(await store.check(user, { ...check, target: "gis" }, key())).toEqual({ decision: "block", reason: "target_not_registered", policyId });
    expect(Number((await pool.query("SELECT count(*) FROM app.action_request WHERE org_id=$1", [user.orgId])).rows[0].count)).toBe(0);
  });
  it("converts the registered CMMS operation once without executing a CMMS write", async () => {
    const { user, check, policyId, systemId } = await fixture();
    const tools = JSON.stringify(["get_asset", "create_action_request", "cmms.create_work_order"]);
    await pool.query("UPDATE app.ai_system SET tools=$1::jsonb WHERE id=$2", [tools, systemId]);
    await pool.query("UPDATE app.guardrail_policy SET config=jsonb_set(config,'{settings,allowedTools}',$1::jsonb) WHERE id=$2", [tools, policyId]);
    const input = { ...check, tool: "cmms.create_work_order" }, savedKey = key();
    const outbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected external call"));
    try {
      const result = await store.check(user, input, savedKey);
      expect(result.decision).toBe("convert_l1");
      expect(result.heldRequestId).toBeUndefined();
      expect(result.actionRequest).toMatchObject({ actionLevel: "l1", actionType: "system_of_record", target: "cmms", status: "open", orgId: user.orgId, requestedBy: user.sub, requester: { kind: "assistant", aiSystemId: systemId } });
      expect((await store.check(user, input, savedKey)).actionRequest?.id).toBe(result.actionRequest?.id);
      expect(Number((await pool.query("SELECT count(*) FROM app.action_request WHERE org_id=$1", [user.orgId])).rows[0].count)).toBe(1);
      expect(Number((await pool.query("SELECT count(*) FROM app.evidence WHERE org_id=$1 AND kind='guardrail.intercept'", [user.orgId])).rows[0].count)).toBe(1);
      expect(outbound).not.toHaveBeenCalled();
      for (const bad of [
        { ...input, target: "fieldloop" as const, actionType: "internal_record" as const },
        { ...input, actionLevel: "l0" as const },
        { ...input, actionLevel: "l2" as const },
        { ...input, target: "gis" as const },
      ]) expect((await store.check(user, bad, key())).decision).toBe("block");
      await expect(store.check({ ...user, orgId: "foreign-org" }, input, key())).rejects.toThrow("tool_registry_unavailable");
      await expect(store.check(user, { ...input, requestedBy: "agent:forged" } as ToolCallCheck, key())).rejects.toThrow("validation_failed");
      await pool.query("INSERT INTO app.action_ceiling (org_id,action_type,action_level,simulated,classification) VALUES ($1,'system_of_record','l0',true,'INTERNAL')", [user.orgId]);
      expect((await store.check(user, input, key())).decision).toBe("block");
      await pool.query("DELETE FROM app.action_ceiling WHERE org_id=$1", [user.orgId]);
      await pool.query("UPDATE app.guardrail_policy SET config=jsonb_set(config,'{settings,allowedTools}','[\"get_asset\",\"create_action_request\"]'::jsonb) WHERE id=$1", [policyId]);
      expect((await store.check(user, input, savedKey)).decision).toBe("block");
      expect(outbound).not.toHaveBeenCalled();
    } finally { outbound.mockRestore(); }
  });
  it("blocks an unregistered CMMS operation and records its Intercept without creating an Action Request", async () => {
    const { user, check } = await fixture();
    expect((await store.check(user, { ...check, tool: "cmms.create_work_order" }, key())).decision).toBe("block");
    expect(Number((await pool.query("SELECT count(*) FROM app.intercept WHERE org_id=$1", [user.orgId])).rows[0].count)).toBe(1);
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
  it("does not replay a converted tool call after its target leaves the AI System allowlist (PRD GR-4)", async () => {
    const { user, check, policyId } = await fixture(), savedKey = key();
    expect((await store.check(user, check, savedKey)).decision).toBe("convert_l1");
    await pool.query("UPDATE app.guardrail_policy SET config = jsonb_set(config, '{settings,allowedTargets}', '[\"fieldloop\"]') WHERE id=$1", [policyId]);
    expect(await store.check(user, check, savedKey)).toEqual({ decision: "block", reason: "target_not_registered", policyId });
  });
  it("fails closed on missing, ambiguous or monitor-only policy and incomplete action metadata", async () => {
    const { user, check, policyId } = await fixture();
    await expect(store.check(user, { ...check, aiSystem: "unknown" }, key())).rejects.toThrow("tool_registry_unavailable");
    await expect(store.check(user, { aiSystem: check.aiSystem, tool: check.tool, target: check.target, actionType: "system_of_record", actionLevel: "l1", simulated: true, classification: "INTERNAL" }, key())).rejects.toThrow("action_metadata_required");
    await pool.query("UPDATE app.guardrail_policy SET config = config #- '{settings,allowedTargets}' WHERE id=$1", [policyId]);
    await expect(store.check(user, check, key())).rejects.toThrow("tool_registry_unavailable");
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
    const actionEvents = await pool.query<{ status: string }>("SELECT event->>'status' AS status FROM app.signal_event_outbox WHERE org_id=$1 AND event->>'entityId'=$2 AND event->>'type'='action_request.updated' ORDER BY created_at, id", [user.orgId, held.actionRequest.id]);
    expect(actionEvents.rows.map(({ status }) => status)).toEqual(["open", "rejected"]);
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
  describe("FL-96 Approver decisions on the exact payload", () => {
    const manager = (user: ActionIdentity, overrides: Partial<ApproverIdentity> = {}): ApproverIdentity =>
      ({ sub: "synthetic-manager", orgId: user.orgId, roles: ["fieldloop.manager"], clearance: "HIGHLY_RESTRICTED", authTime: new Date(), ...overrides });
    async function pending() {
      const f = await fixture();
      const action = await store.create(f.user, f.body, key());
      return { ...f, action, approver: manager(f.user), decision: { payloadHash: action.payloadHash, reason: "Reviewed the exact payload" } };
    }
    const count = async (sqlText: string, args: unknown[]) => Number((await pool.query(sqlText, args)).rows[0].count);
    it("approves only the payload hash the Approver saw, records auth_time, audits and replays by Idempotency-Key", async () => {
      const { action, approver, decision } = await pending(), idempotencyKey = key();
      const results = await Promise.all(Array.from({ length: 4 }, () => store.decide(approver, action.id, "approved", decision, idempotencyKey)));
      expect(new Set(results.map(x => x.approval.id)).size).toBe(1);
      expect(results[0]).toMatchObject({ actionRequest: { id: action.id, status: "approved", payloadHash: action.payloadHash },
        approval: { decision: "approved", approverSub: approver.sub, payloadHash: action.payloadHash, reason: decision.reason, authTime: approver.authTime.toISOString() } });
      const stored = (await pool.query("SELECT * FROM app.approval WHERE action_request_id=$1", [action.id])).rows;
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ approver_sub: approver.sub, payload_hash: action.payloadHash, voided_at: null, simulated: true });
      expect(await count("SELECT count(*) FROM app.audit_event WHERE org_id=$1 AND action='action_request.approved' AND entity=$2", [approver.orgId, action.id])).toBe(1);
      const actionEvents = await pool.query<{ status: string }>("SELECT event->>'status' AS status FROM app.signal_event_outbox WHERE org_id=$1 AND event->>'entityId'=$2 AND event->>'type'='action_request.updated' ORDER BY created_at, id", [approver.orgId, action.id]);
      expect(actionEvents.rows.map(({ status }) => status)).toEqual(["open", "approved"]);
      await expect(store.decide(approver, action.id, "approved", { ...decision, reason: "Different reason" }, idempotencyKey)).rejects.toThrow("idempotency_key_reused");
    });
    it("refuses a stale or changed payload hash and any payload edit voids the Approval", async () => {
      const { action, approver, decision } = await pending();
      await expect(store.decide(approver, action.id, "approved", { ...decision, payloadHash: "0".repeat(64) }, key())).rejects.toThrow("payload_changed");
      expect(await count("SELECT count(*) FROM app.approval WHERE action_request_id=$1", [action.id])).toBe(0);
      await store.decide(approver, action.id, "approved", decision, key());
      await pool.query("UPDATE app.action_request SET payload = payload || '{\"edited\":true}'::jsonb WHERE id=$1", [action.id]);
      const after = (await pool.query("SELECT status, payload_hash FROM app.action_request WHERE id=$1", [action.id])).rows[0];
      expect(after.status).toBe("open"); expect(after.payload_hash).not.toBe(action.payloadHash);
      expect(await count("SELECT count(*) FROM app.approval WHERE action_request_id=$1 AND voided_at IS NULL", [action.id])).toBe(0);
      await expect(store.decide(manager({ ...approver, orgId: approver.orgId }, { sub: "synthetic-manager-two" }), action.id, "approved", decision, key())).rejects.toThrow("payload_changed");
    });
    it("enforces four-eyes, the manager role, recent re-login, clearance and Organisation scope before any write", async () => {
      const { user, action, approver, decision } = await pending();
      // The requester, even holding the manager role, can never decide their own request; nor can an assistant's delegating user.
      await expect(store.decide({ ...approver, sub: user.sub }, action.id, "approved", decision, key())).rejects.toThrow("four_eyes_required");
      await expect(store.decide({ ...approver, roles: ["fieldloop.operator"] }, action.id, "approved", decision, key())).rejects.toThrow("forbidden");
      await expect(store.decide({ ...approver, roles: ["fieldloop.viewer"] }, action.id, "rejected", decision, key())).rejects.toThrow("forbidden");
      for (const authTime of [new Date(Date.now() - 6 * 60_000), new Date(Date.now() + 5 * 60_000), new Date(0)]) {
        await expect(store.decide({ ...approver, authTime }, action.id, "approved", decision, key())).rejects.toThrow("reauthentication_required");
      }
      await expect(store.decide({ ...approver, clearance: "PUBLIC" }, action.id, "approved", decision, key())).rejects.toThrow("forbidden");
      await expect(store.decide({ ...approver, orgId: `other-${randomUUID()}` }, action.id, "approved", decision, key())).rejects.toThrow("not_found");
      expect(await count("SELECT count(*) FROM app.approval WHERE action_request_id=$1", [action.id])).toBe(0);
      expect((await store.get(approver, action.id)).status).toBe("open");
    });
    it("lets one Approver decide once, even concurrently under different keys", async () => {
      const { action, approver, decision } = await pending();
      const outcomes = await Promise.allSettled([store.decide(approver, action.id, "approved", decision, key()), store.decide(approver, action.id, "rejected", decision, key())]);
      expect(outcomes.filter(x => x.status === "fulfilled")).toHaveLength(1);
      expect(await count("SELECT count(*) FROM app.approval WHERE action_request_id=$1", [action.id])).toBe(1);
      await expect(store.decide(approver, action.id, "approved", decision, key())).rejects.toThrow("not_pending");
    });
    it("treats an expired request as rejected and escalated, never approvable", async () => {
      const { action, approver, decision } = await pending();
      await pool.query("UPDATE app.action_request SET expires_at = clock_timestamp() - interval '1 second' WHERE id=$1", [action.id]);
      await expect(store.decide(approver, action.id, "approved", decision, key())).rejects.toThrow("request_expired");
      expect(await count("SELECT count(*) FROM app.approval WHERE action_request_id=$1", [action.id])).toBe(0);
      expect((await pool.query("SELECT status, rejection_reason FROM app.action_request WHERE id=$1", [action.id])).rows[0]).toEqual({ status: "rejected", rejection_reason: "sla_expired" });
      expect(await count("SELECT count(*) FROM app.action_escalation WHERE action_request_id=$1", [action.id])).toBe(1);
    });
    it("reports a request that expires mid-decision as expired, records no Approval and never approves it", async () => {
      const { action, approver, decision } = await pending();
      await pool.query("UPDATE app.action_request SET expires_at = clock_timestamp() + interval '700 milliseconds' WHERE id=$1", [action.id]);
      // Slows the Approval insert past the deadline, after the expiry sweep has already found the request still open.
      await pool.query("CREATE FUNCTION app.fl96_slow_approval() RETURNS trigger AS $$ BEGIN PERFORM pg_sleep(1); RETURN NEW; END $$ LANGUAGE plpgsql");
      await pool.query("CREATE TRIGGER zz_fl96_slow_approval BEFORE INSERT ON app.approval FOR EACH ROW EXECUTE FUNCTION app.fl96_slow_approval()");
      try { await expect(store.decide(approver, action.id, "approved", decision, key())).rejects.toThrow("request_expired"); }
      finally {
        await pool.query("DROP TRIGGER zz_fl96_slow_approval ON app.approval");
        await pool.query("DROP FUNCTION app.fl96_slow_approval()");
      }
      expect(await count("SELECT count(*) FROM app.approval WHERE action_request_id=$1", [action.id])).toBe(0);
      expect((await pool.query("SELECT status FROM app.action_request WHERE id=$1", [action.id])).rows[0].status).toBe("open");
    });
    it("rejects with a recorded reason and closes the linked Held Request, while an approval does not release it", async () => {
      const { user, check } = await fixture();
      const approver = manager(user);
      const l2 = { ...check, actionType: "emergency_communication" as const, actionLevel: "l2" as const, target: "stakeholders" as const };
      const first = await store.check(user, l2, key()), second = await store.check(user, { ...l2, payload: { message: "SIMULATION drill two" } }, key());
      if (!first.actionRequest || !second.actionRequest || !first.heldRequestId || !second.heldRequestId) throw new Error("Missing held L2 request");
      const approved = await store.decide(approver, first.actionRequest.id, "approved", { payloadHash: first.actionRequest.payloadHash, reason: "Reviewed" }, key());
      expect(approved.actionRequest.status).toBe("approved");
      expect((await pool.query("SELECT status FROM app.held_request WHERE id=$1", [first.heldRequestId])).rows[0].status).toBe("held");
      const rejected = await store.decide(approver, second.actionRequest.id, "rejected", { payloadHash: second.actionRequest.payloadHash, reason: "Not needed for the drill" }, key());
      expect(rejected).toMatchObject({ actionRequest: { status: "rejected" }, approval: { decision: "rejected", reason: "Not needed for the drill" } });
      expect((await pool.query("SELECT status, rejection_reason FROM app.held_request WHERE id=$1", [second.heldRequestId])).rows[0]).toEqual({ status: "rejected", rejection_reason: "approver_rejected" });
      expect(await count("SELECT count(*) FROM app.audit_event WHERE org_id=$1 AND action='action_request.rejected'", [user.orgId])).toBe(1);
    });
    it("rolls back the Approval, status and audit if the decision cannot be fully recorded", async () => {
      const { action, approver, decision } = await pending();
      const ddl = (await pool.query("SELECT format('ALTER TABLE app.action_check_result ADD CONSTRAINT fl96_synthetic_failure CHECK (org_id <> %L OR operation <> ''approve'') NOT VALID', $1::text) AS statement", [approver.orgId])).rows[0].statement;
      await pool.query(ddl);
      try { await expect(store.decide(approver, action.id, "approved", decision, key())).rejects.toThrow(); }
      finally { await pool.query("ALTER TABLE app.action_check_result DROP CONSTRAINT fl96_synthetic_failure"); }
      expect(await count("SELECT count(*) FROM app.approval WHERE action_request_id=$1", [action.id])).toBe(0);
      expect((await store.get(approver, action.id)).status).toBe("open");
      expect(await count("SELECT count(*) FROM app.audit_event WHERE org_id=$1 AND action='action_request.approved'", [approver.orgId])).toBe(0);
    });
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
