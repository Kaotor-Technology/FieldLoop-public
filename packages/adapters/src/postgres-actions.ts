import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import { isActionRequestCreate, isToolCallCheck, type ActionClassification, type ActionLevel, type ActionRequest, type ActionRequestCreate, type ActionRequester, type ActionType, type ToolCallCheck, type ToolCallDecision } from "@fieldloop/contracts";
import { ActionError, effectiveCeiling, evaluateToolCall, levelRank, targetMatches } from "./action-policy.js";
import { appendAuditEvent, appendWorkerEvent } from "./postgres-domain-events.js";

type Database = Record<string, never>;
type Tx = Transaction<Database>;
export interface ActionIdentity { sub: string; orgId: string; roles: string[]; clearance: string }
export interface ActionServicePort {
  create(user: ActionIdentity, body: ActionRequestCreate, key: string): Promise<ActionRequest>;
  check(user: ActionIdentity, body: ToolCallCheck, key: string): Promise<ToolCallDecision>;
  get(user: ActionIdentity, id: string): Promise<ActionRequest>;
  expire(orgId: string, simulatedOnly?: boolean): Promise<number>;
}
interface ActionRow {
  id: string; org_id: string; action_type: ActionType; action_level: ActionLevel; target: ActionRequest["target"];
  payload: ActionRequest["payload"]; payload_hash: string; rationale: string; citations: string[]; requested_by: string;
  requester_kind: ActionRequester["kind"]; requester_ai_system_id: string | null;
  status: ActionRequest["status"]; expires_at: Date; simulated: boolean; classification: ActionClassification;
  simulation_run_id: string | null;
}
const classes = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED"];
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
// Recursively sorted keys make an idempotency replay independent of JSON object insertion order.
export function canonicalActionJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalActionJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalActionJson(Reflect.get(value, key))}`).join(",")}}`;
}
export class PostgresActionStore implements ActionServicePort {
  constructor(private readonly db: Kysely<Database>, private readonly simulatedOnly = true) {}

  async create(user: ActionIdentity, body: ActionRequestCreate, key: string): Promise<ActionRequest> {
    if (!isActionRequestCreate(body)) throw new ActionError(400, "validation_failed");
    if (this.simulatedOnly && !body.simulated) throw new ActionError(403, "simulation_required");
    authorize(user, body.classification, true);
    if (body.actionLevel === "l0" || !targetMatches(body.actionType, body.target)) throw new ActionError(400, "action_target_mismatch");
    return this.db.transaction().execute(async trx => {
      await lockOrganisation(trx, user.orgId);
      await lockSimulationScope(trx, user.orgId, body.simulated, body.simulationRunId);
      await expireRequests(trx, user.orgId, this.simulatedOnly);
      const policy = await loadCeiling(trx, user.orgId, body.actionType, body.simulated);
      if (levelRank(body.actionLevel) > levelRank(policy.ceiling)) throw new ActionError(403, "above_action_ceiling");
      const previous = await replay(trx, user, "create", body, key);
      if (previous) {
        if (!previous.action_request_id) throw new Error("Action creation has no record");
        return readAction(trx, user, previous.action_request_id);
      }
      const action = await insertAction(trx, user, body, policy.slaSeconds, { kind: "person" });
      await remember(trx, user, "create", body, key, {}, action.id);
      return action;
    });
  }

  async check(user: ActionIdentity, body: ToolCallCheck, key: string): Promise<ToolCallDecision> {
    if (!isToolCallCheck(body)) throw new ActionError(400, "validation_failed");
    if (this.simulatedOnly && !body.simulated) throw new ActionError(403, "simulation_required");
    authorize(user, body.classification, false);
    const started = performance.now();
    return this.db.transaction().execute(async trx => {
      await lockOrganisation(trx, user.orgId);
      await lockSimulationScope(trx, user.orgId, body.simulated, body.simulationRunId);
      await expireRequests(trx, user.orgId, this.simulatedOnly);
      const rows = (await sql<{ id: string; tools: unknown; classification: string; data_classes: unknown; policy_id: string; barrier_id: string; config: Record<string, unknown>; mode: string; fail_mode: string }>`
        SELECT s.id, s.tools, s.classification, s.data_classes, p.id AS policy_id, p.barrier_id, p.config, p.mode, p.fail_mode
        FROM app.ai_system s JOIN app.guardrail_policy p ON p.ai_system_id = s.id AND p.org_id = s.org_id AND p.simulated = s.simulated
        WHERE s.org_id = ${user.orgId} AND s.simulated = ${body.simulated}
          AND p.config->>'aiSystemCode' = ${body.aiSystem} AND p.config->>'kind' = 'tool-call'
        FOR SHARE OF s, p`.execute(trx)).rows;
      const registry = rows[0];
      if (!registry || rows.length !== 1 || registry.mode !== "enforce" || registry.fail_mode !== "fail-closed" || !registry.barrier_id) {
        throw new ActionError(503, "tool_registry_unavailable");
      }
      authorize(user, registry.classification, false);
      if (!Array.isArray(registry.data_classes) || !registry.data_classes.includes(body.classification)) throw new ActionError(403, "classification_not_registered");
      const settings = registry.config["settings"];
      const policyTools: unknown = settings && typeof settings === "object" ? Reflect.get(settings, "allowedTools") : undefined;
      if (!Array.isArray(registry.tools) || !registry.tools.every(x => typeof x === "string")
        || !Array.isArray(policyTools) || !policyTools.every(x => typeof x === "string")) throw new ActionError(503, "tool_registry_unavailable");
      const classification = classes.indexOf(registry.classification) > classes.indexOf(body.classification)
        ? registry.classification as ActionClassification : body.classification;
      const policy = body.actionType ? await loadCeiling(trx, user.orgId, body.actionType, body.simulated) : undefined;
      const result = evaluateToolCall(body, registry.tools.filter(x => policyTools.includes(x)), policy?.ceiling);
      if (result.decision === "convert_l1" || result.decision === "hold_l2") authorize(user, body.classification, true);
      const previous = await replay(trx, user, "check", body, key);
      if (previous) {
        // A changed policy cannot restore an old allow; re-evaluate before replaying artifacts.
        if (result.decision === "block") return result;
        const saved = previous.result;
        if (previous.action_request_id) {
          const action = await readAction(trx, user, previous.action_request_id);
          if (action.status === "rejected" || action.status === "superseded") return { decision: "block", reason: "request_expired_or_superseded" };
          if (saved.actionRequest?.payloadHash !== action.payloadHash) return { decision: "block", reason: "payload_changed" };
          if (saved.heldRequestId) {
            const hold = (await sql<{ status: string }>`SELECT status FROM app.held_request WHERE id = ${saved.heldRequestId}::uuid AND org_id = ${user.orgId}`.execute(trx)).rows[0];
            if (hold?.status !== "held") return { decision: "block", reason: "hold_no_longer_pending" };
          }
          return { ...saved, actionRequest: action };
        }
        return result;
      }
      let action: ActionRequest | undefined;
      const interceptId = randomUUID();
      let heldRequestId: string | undefined;
      if (result.decision === "convert_l1" || result.decision === "hold_l2") {
        const actionInput = actionBody({ ...body, classification });
        if (!isActionRequestCreate(actionInput)) throw new ActionError(400, "action_metadata_required");
        action = await insertAction(trx, user, actionInput, policy?.slaSeconds ?? 900, { kind: "assistant", aiSystemId: registry.id });
      }
      await sql`INSERT INTO app.intercept (id, org_id, policy_id, ai_system_id, decision, reason, latency_ms, simulated, classification, created_by)
        VALUES (${interceptId}::uuid, ${user.orgId}, ${registry.policy_id}::uuid, ${registry.id}::uuid,
          ${result.decision}, ${result.reason}, ${Math.round(performance.now() - started)}, ${body.simulated}, ${classification}, ${user.sub})`.execute(trx);
      const evidenceId = randomUUID();
      await sql`INSERT INTO app.evidence (id, org_id, barrier_id, kind, source, observed_at, simulated, classification, created_by, simulation_run_id)
        VALUES (${evidenceId}::uuid, ${user.orgId}, ${registry.barrier_id}::uuid, 'guardrail.intercept', 'guardrail', clock_timestamp(),
          ${body.simulated}, ${classification}, 'guardrail', ${body.simulationRunId ?? null}::uuid)`.execute(trx);
      await appendWorkerEvent(trx, { id: randomUUID(), type: "evidence.created", orgId: user.orgId, entityId: evidenceId, barrierId: registry.barrier_id, simulated: body.simulated, classification }, "guardrail");
      if (result.decision === "hold_l2" && action) {
        heldRequestId = randomUUID();
        await sql`INSERT INTO app.held_request (id, org_id, intercept_id, action_request_id, payload, status, expires_at, simulated, classification, created_by)
          VALUES (${heldRequestId}::uuid, ${user.orgId}, ${interceptId}::uuid, ${action.id}::uuid, ${JSON.stringify(action.payload)}::jsonb,
            'held', ${action.expiresAt}::timestamptz, ${action.simulated}, ${action.classification}, ${user.sub})`.execute(trx);
      }
      const response: ToolCallDecision = { ...result, ...(action ? { actionRequest: action } : {}), ...(heldRequestId ? { heldRequestId } : {}) };
      await appendAuditEvent(trx, { orgId: user.orgId, actor: user.sub, action: "tool_call.checked", entity: interceptId,
        before: null, after: { ...response, aiSystemId: registry.id, tool: body.tool, target: body.target }, simulated: body.simulated, classification, createdBy: "guardrail" });
      await remember(trx, user, "check", body, key, response, action?.id, classification);
      return response;
    });
  }

  async get(user: ActionIdentity, id: string): Promise<ActionRequest> {
    return this.db.transaction().execute(async trx => {
      await lockOrganisation(trx, user.orgId);
      await expireRequests(trx, user.orgId, this.simulatedOnly);
      return readAction(trx, user, id);
    });
  }
  async expire(orgId: string, simulatedOnly = false): Promise<number> {
    return this.db.transaction().execute(async trx => {
      await lockOrganisation(trx, orgId);
      return expireRequests(trx, orgId, simulatedOnly);
    });
  }
}
function actionBody(body: ToolCallCheck): unknown {
  return Object.fromEntries(Object.entries(body).filter(([key]) => key !== "aiSystem" && key !== "tool"));
}
function authorize(user: ActionIdentity, classification: string, write: boolean): void {
  const clearance = classes.indexOf(user.clearance), level = classes.indexOf(classification);
  if (clearance < 0 || level < 0 || clearance < level || !user.orgId || !user.sub) throw new ActionError(403, "forbidden");
  if (write && !user.roles.some(x => x === "fieldloop.operator" || x === "fieldloop.manager")) throw new ActionError(403, "forbidden");
}
async function lockOrganisation(trx: Tx, orgId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([orgId, "action_requests"])}, 0))`.execute(trx);
  // Reset locks the workspace before Action rows. Preserve that order for reads and expiry too.
  await sql`SELECT org_id FROM app.simulation_workspace WHERE org_id = ${orgId} FOR SHARE`.execute(trx);
}
async function lockSimulationScope(trx: Tx, orgId: string, simulated: boolean, runId?: string): Promise<void> {
  const workspace = (await sql<{ active_run_id: string | null }>`SELECT active_run_id FROM app.simulation_workspace WHERE org_id = ${orgId} FOR SHARE`.execute(trx)).rows[0];
  if (!simulated) {
    if (runId !== undefined) throw new ActionError(409, "simulation_scope_invalid");
    return;
  }
  if (workspace?.active_run_id && !runId) throw new ActionError(409, "simulation_scope_invalid");
  if (runId) {
    try { await sql`SELECT app.assert_simulation_run(${runId}::uuid, ${orgId})`.execute(trx); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "23514") throw new ActionError(409, "simulation_scope_invalid");
      throw error;
    }
  }
}
async function loadCeiling(trx: Tx, orgId: string, type: ActionType, simulated: boolean) {
  const row = (await sql<{ action_level: ActionLevel; sla_seconds: number }>`SELECT action_level, sla_seconds FROM app.action_ceiling
    WHERE org_id = ${orgId} AND action_type = ${type} AND simulated = ${simulated} FOR SHARE`.execute(trx)).rows[0];
  return { ceiling: effectiveCeiling(type, row?.action_level), slaSeconds: row?.sla_seconds ?? 900 };
}
async function readAction(trx: Tx, user: ActionIdentity, id: string): Promise<ActionRequest> {
  const row = (await sql<ActionRow>`SELECT * FROM app.action_request WHERE simulation_retired_at IS NULL AND id = ${id}::uuid AND org_id = ${user.orgId}`.execute(trx)).rows[0];
  if (!row) throw new ActionError(404, "not_found");
  authorize(user, row.classification, false);
  return toAction(row);
}
function toAction(row: ActionRow): ActionRequest {
  return { id: row.id, orgId: row.org_id, actionType: row.action_type, actionLevel: row.action_level, target: row.target,
    payload: row.payload, payloadHash: row.payload_hash, rationale: row.rationale, citations: row.citations,
    requestedBy: row.requested_by,
    requester: row.requester_kind === "assistant" && row.requester_ai_system_id
      ? { kind: "assistant", aiSystemId: row.requester_ai_system_id } : { kind: "person" },
    status: row.status, expiresAt: row.expires_at.toISOString(), simulated: row.simulated,
    classification: row.classification, ...(row.simulation_run_id ? { simulationRunId: row.simulation_run_id } : {}) };
}
async function insertAction(trx: Tx, user: ActionIdentity, body: ActionRequestCreate, slaSeconds: number, requester: ActionRequester): Promise<ActionRequest> {
  const now = (await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(trx)).rows[0]?.now;
  if (!now) throw new Error("Database clock unavailable");
  const maxExpiry = now.getTime() + slaSeconds * 1000;
  const expiresAt = body.expiresAt ? new Date(body.expiresAt) : new Date(maxExpiry);
  if (expiresAt.getTime() <= now.getTime() || expiresAt.getTime() > maxExpiry) throw new ActionError(400, "invalid_expiry");
  const row = (await sql<ActionRow>`INSERT INTO app.action_request
    (org_id, action_type, action_level, target, payload, rationale, citations, requested_by, requester_kind, requester_ai_system_id,
      status, expires_at, simulated, classification, created_by, simulation_run_id, created_at)
    VALUES (${user.orgId}, ${body.actionType}, ${body.actionLevel}, ${body.target}, ${JSON.stringify(body.payload)}::jsonb,
      ${body.rationale}, ${JSON.stringify(body.citations)}::jsonb, ${user.sub}, ${requester.kind},
      ${requester.kind === "assistant" ? requester.aiSystemId : null}::uuid, 'open', ${expiresAt}::timestamptz,
      ${body.simulated}, ${body.classification}, ${user.sub}, ${body.simulationRunId ?? null}::uuid, ${now}::timestamptz) RETURNING *`.execute(trx)).rows[0];
  if (!row) throw new Error("Action Request was not inserted");
  const action = toAction(row);
  await appendAuditEvent(trx, { orgId: user.orgId, actor: user.sub, action: "action_request.created", entity: action.id,
    before: null, after: action, simulated: body.simulated, classification: body.classification, createdBy: "action-service" });
  return action;
}
interface Saved { request_hash: string; result: ToolCallDecision; action_request_id: string | null }
async function replay(trx: Tx, user: ActionIdentity, operation: string, body: unknown, key: string): Promise<Saved | undefined> {
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(key)) throw new ActionError(400, "validation_failed");
  const row = (await sql<Saved>`SELECT request_hash, result, action_request_id FROM app.action_check_result
    WHERE org_id = ${user.orgId} AND actor = ${user.sub} AND operation = ${operation} AND key_hash = ${digest(key)}`.execute(trx)).rows[0];
  if (row && row.request_hash !== digest(canonicalActionJson(body))) throw new ActionError(409, "idempotency_key_reused");
  return row;
}
async function remember(trx: Tx, user: ActionIdentity, operation: string, body: ActionRequestCreate | ToolCallCheck, key: string, result: unknown, actionId?: string, classification: ActionClassification = body.classification) {
  await sql`INSERT INTO app.action_check_result (org_id, actor, operation, key_hash, request_hash, result, action_request_id, simulated, classification)
    VALUES (${user.orgId}, ${user.sub}, ${operation}, ${digest(key)}, ${digest(canonicalActionJson(body))}, ${JSON.stringify(result)}::jsonb,
      ${actionId ?? null}::uuid, ${body.simulated}, ${classification})`.execute(trx);
}
async function expireRequests(trx: Tx, orgId: string, simulatedOnly: boolean): Promise<number> {
  const rows = (await sql<ActionRow>`UPDATE app.action_request SET status = 'rejected', rejection_reason = 'sla_expired'
    WHERE org_id = ${orgId} AND (NOT ${simulatedOnly} OR simulated) AND simulation_retired_at IS NULL
      AND status IN ('open', 'in_review', 'awaiting_second', 'approved') AND expires_at <= clock_timestamp() RETURNING *`.execute(trx)).rows;
  for (const row of rows) {
    await sql`UPDATE app.held_request SET status = 'rejected', rejection_reason = 'sla_expired'
      WHERE action_request_id = ${row.id}::uuid AND org_id = ${orgId} AND status IN ('held', 'allowed')`.execute(trx);
    await sql`INSERT INTO app.action_escalation (org_id, action_request_id, reason, simulated, classification)
      VALUES (${orgId}, ${row.id}::uuid, 'sla_expired', ${row.simulated}, ${row.classification}) ON CONFLICT (action_request_id) DO NOTHING`.execute(trx);
    await sql`INSERT INTO app.notification (org_id, action_request_id, channel, recipient_ref, status, receipt, sandbox, simulated, classification, created_by, simulation_run_id)
      VALUES (${orgId}, ${row.id}::uuid, 'in_app', ${row.simulated ? 'sandbox:ai-governance' : 'role:fieldloop.manager'}, 'pending',
        '{"reason":"sla_expired"}'::jsonb, ${row.simulated}, ${row.simulated}, ${row.classification}, 'sla-expiry', ${row.simulation_run_id}::uuid)`.execute(trx);
    await appendAuditEvent(trx, { orgId, actor: "sla-expiry", action: "action_request.expired", entity: row.id,
      before: null, after: { status: "rejected", reason: "sla_expired", escalated: true }, simulated: row.simulated, classification: row.classification, createdBy: "action-service" });
  }
  return rows.length;
}
