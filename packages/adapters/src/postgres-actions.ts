import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import { isActionDecisionCreate, isActionRequestCreate, isToolCallCheck, type ActionApproval, type ActionClassification, type ActionDecisionCreate, type ActionDecisionResult, type ActionLevel, type ActionRequest, type ActionRequestCreate, type ActionRequester, type ActionType, type ToolCallCheck, type ToolCallDecision } from "@fieldloop/contracts";
import { ActionError, effectiveCeiling, evaluateToolCall, levelRank, targetMatches } from "./action-policy.js";
import { appendAuditEvent, appendWorkerEvent } from "./postgres-domain-events.js";

type Database = Record<string, never>;
type Tx = Transaction<Database>;
export interface ActionIdentity { sub: string; orgId: string; roles: string[]; clearance: string }
/** An Approver's session: `authTime` is the Keycloak `auth_time` of the forced re-login (PRD AX-3). */
export interface ApproverIdentity extends ActionIdentity { authTime: Date }
export type ActionDecision = "approved" | "rejected";
// Realm example-realm has no step-up, so a decision needs a login at most this old (architecture §4.3).
export const APPROVAL_MAX_AUTH_AGE_MS = 5 * 60 * 1000;
export const APPROVAL_AUTH_CLOCK_SKEW_MS = 30 * 1000;
/** Approver decisions are a separate port, so the Guardrail's `ActionServicePort` has no way to approve (PRD AX-9). */
export interface ActionDecisionPort {
  decide(user: ApproverIdentity, id: string, decision: ActionDecision, body: ActionDecisionCreate, key: string): Promise<ActionDecisionResult>;
}
export interface ActionServicePort {
  create(user: ActionIdentity, body: ActionRequestCreate, key: string): Promise<ActionRequest>;
  check(user: ActionIdentity, body: ToolCallCheck, key: string): Promise<ToolCallDecision>;
  get(user: ActionIdentity, id: string): Promise<ActionRequest>;
  expire(orgId: string, simulatedOnly?: boolean): Promise<number>;
}
interface ApprovalRow {
  id: string; action_request_id: string; approver_sub: string; decision: ActionDecision; reason: string | null;
  payload_hash: string; auth_time: Date; created_at: Date;
}
interface ActionRow {
  id: string; org_id: string; action_type: ActionType; action_level: ActionLevel; target: ActionRequest["target"];
  payload: ActionRequest["payload"]; payload_hash: string; rationale: string; citations: string[]; requested_by: string;
  requester_kind: ActionRequester["kind"]; requester_ai_system_id: string | null;
  status: ActionRequest["status"]; expires_at: Date; simulated: boolean; classification: ActionClassification;
  simulation_run_id: string | null; rejection_reason: string | null;
}
const classes = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED"];
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
// Recursively sorted keys make an idempotency replay independent of JSON object insertion order.
export function canonicalActionJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalActionJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalActionJson(Reflect.get(value, key))}`).join(",")}}`;
}
export class PostgresActionStore implements ActionServicePort, ActionDecisionPort {
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
      const policyTargets: unknown = settings && typeof settings === "object" ? Reflect.get(settings, "allowedTargets") : undefined;
      // A policy without a target allowlist fails closed rather than allowing every target (PRD GR-4).
      if (!Array.isArray(registry.tools) || !registry.tools.every(x => typeof x === "string")
        || !Array.isArray(policyTools) || !policyTools.every(x => typeof x === "string")
        || !Array.isArray(policyTargets) || !policyTargets.every(x => typeof x === "string")) throw new ActionError(503, "tool_registry_unavailable");
      const classification = classes.indexOf(registry.classification) > classes.indexOf(body.classification)
        ? registry.classification as ActionClassification : body.classification;
      const policy = body.actionType ? await loadCeiling(trx, user.orgId, body.actionType, body.simulated) : undefined;
      const result = evaluateToolCall(body, { tools: registry.tools.filter(x => policyTools.includes(x)), targets: policyTargets }, policy?.ceiling);
      if (result.decision === "convert_l1" || result.decision === "hold_l2") authorize(user, body.classification, true);
      const previous = await replay(trx, user, "check", body, key);
      if (previous) {
        // A changed policy cannot restore an old allow; re-evaluate before replaying artifacts.
        if (result.decision === "block") return { ...result, policyId: registry.policy_id };
        const saved = previous.result;
        if (previous.action_request_id) {
          const action = await readAction(trx, user, previous.action_request_id);
          if (action.status === "rejected" || action.status === "superseded") return { decision: "block", reason: "request_expired_or_superseded", policyId: registry.policy_id };
          if (saved.actionRequest?.payloadHash !== action.payloadHash) return { decision: "block", reason: "payload_changed", policyId: registry.policy_id };
          if (saved.heldRequestId) {
            const hold = (await sql<{ status: string }>`SELECT status FROM app.held_request WHERE id = ${saved.heldRequestId}::uuid AND org_id = ${user.orgId}`.execute(trx)).rows[0];
            if (hold?.status !== "held") return { decision: "block", reason: "hold_no_longer_pending", policyId: registry.policy_id };
          }
          return { ...saved, policyId: registry.policy_id, actionRequest: action };
        }
        return { ...result, policyId: registry.policy_id };
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
      const response: ToolCallDecision = { ...result, policyId: registry.policy_id, ...(action ? { actionRequest: action } : {}), ...(heldRequestId ? { heldRequestId } : {}) };
      await appendAuditEvent(trx, { orgId: user.orgId, actor: user.sub, action: "tool_call.checked", entity: interceptId,
        before: null, after: { ...response, aiSystemId: registry.id, tool: body.tool, target: body.target }, simulated: body.simulated, classification, createdBy: "guardrail" });
      await remember(trx, user, "check", body, key, response, action?.id, classification);
      return response;
    });
  }

  // One Approver decision on the exact payload they saw (PRD AX-2, AX-3). It never executes the payload and never
  // releases a Held Request; the working two-person rule is Phase 1, so one Approval authorises in the demo.
  async decide(user: ApproverIdentity, id: string, decision: ActionDecision, body: ActionDecisionCreate, key: string): Promise<ActionDecisionResult> {
    if (!isActionDecisionCreate(body)) throw new ActionError(400, "validation_failed");
    // Only a person with the manager role decides; an AI subject has no session or role and can never reach this (AX-9).
    if (!user.roles.includes("fieldloop.manager") || !user.orgId || !user.sub) throw new ActionError(403, "forbidden");
    const operation = decision === "approved" ? "approve" : "reject";
    // Reporting an expired request must not roll back the rejection and escalation that expiry just recorded (PRD AX-4).
    let expired = false;
    const result = await this.db.transaction().execute(async trx => {
      await lockOrganisation(trx, user.orgId);
      await expireRequests(trx, user.orgId, this.simulatedOnly);
      const row = (await sql<ActionRow>`SELECT * FROM app.action_request WHERE simulation_retired_at IS NULL AND id = ${id}::uuid AND org_id = ${user.orgId} FOR UPDATE`.execute(trx)).rows[0];
      if (!row) throw new ActionError(404, "not_found");
      authorize(user, row.classification, false);
      const now = (await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(trx)).rows[0]?.now;
      if (!now) throw new Error("Database clock unavailable");
      const authAge = now.getTime() - user.authTime.getTime();
      if (!(authAge >= -APPROVAL_AUTH_CLOCK_SKEW_MS && authAge < APPROVAL_MAX_AUTH_AGE_MS)) throw new ActionError(403, "reauthentication_required");
      const keyed = { actionRequestId: id, ...body, simulated: row.simulated, classification: row.classification };
      const previous = await replay(trx, user, operation, keyed, key);
      if (previous) {
        const saved = previous.result.approvalId;
        const stored = saved ? (await sql<ApprovalRow>`SELECT * FROM app.approval WHERE id = ${saved}::uuid AND org_id = ${user.orgId} AND action_request_id = ${id}::uuid`.execute(trx)).rows[0] : undefined;
        if (!stored) throw new Error("Action decision has no record");
        return { actionRequest: toAction(row), approval: toApproval(stored) };
      }
      if (this.simulatedOnly && !row.simulated) throw new ActionError(403, "simulation_required");
      // Four-eyes: the person who raised the request, or for whom an assistant raised it, cannot decide it (PRD WF-4).
      if (row.requested_by === user.sub) throw new ActionError(403, "four_eyes_required");
      if (row.status === "rejected" && row.rejection_reason === "sla_expired") { expired = true; return undefined; }
      if (row.status !== "open" && row.status !== "in_review") throw new ActionError(409, "not_pending");
      if (row.payload_hash !== body.payloadHash) throw new ActionError(409, "payload_changed");
      let approval: ApprovalRow | undefined;
      try {
        approval = (await sql<ApprovalRow>`INSERT INTO app.approval (org_id, action_request_id, approver_sub, decision, reason, payload_hash, auth_time, simulated, classification, created_by)
          VALUES (${user.orgId}, ${id}::uuid, ${user.sub}, ${decision}, ${body.reason}, ${row.payload_hash}, ${user.authTime.toISOString()}::timestamptz,
            ${row.simulated}, ${row.classification}, ${user.sub}) RETURNING *`.execute(trx)).rows[0];
      } catch (error) {
        if (pgCode(error) === "23505") throw new ActionError(409, "already_decided");
        if (pgCode(error) === "23514") throw new ActionError(409, /payload_hash/.test(pgMessage(error)) ? "payload_changed" : "simulation_scope_invalid");
        throw error;
      }
      if (!approval) throw new Error("Approval was not inserted");
      let updated: ActionRow | undefined;
      try {
        updated = (decision === "approved"
          ? await sql<ActionRow>`UPDATE app.action_request SET status = 'approved' WHERE id = ${id}::uuid RETURNING *`.execute(trx)
          : await sql<ActionRow>`UPDATE app.action_request SET status = 'rejected', rejection_reason = 'approver_rejected' WHERE id = ${id}::uuid RETURNING *`.execute(trx)).rows[0];
      } catch (error) {
        // The database deadline guard refused a request that expired after the sweep above; the Scheduler records its expiry.
        if (pgCode(error) === "23514" && /Expired/.test(pgMessage(error))) throw new ActionError(409, "request_expired");
        throw error;
      }
      if (!updated) throw new Error("Action Request was not updated");
      // A rejection also closes any linked Held Request, so a rejected payload can never be released.
      if (decision === "rejected") {
        await sql`UPDATE app.held_request SET status = 'rejected', rejection_reason = 'approver_rejected'
          WHERE action_request_id = ${id}::uuid AND org_id = ${user.orgId} AND status IN ('held', 'allowed')`.execute(trx);
      }
      const decided = { actionRequest: toAction(updated), approval: toApproval(approval) };
      await appendActionRequestUpdate(trx, decided.actionRequest);
      await appendAuditEvent(trx, { orgId: user.orgId, actor: user.sub, action: decision === "approved" ? "action_request.approved" : "action_request.rejected",
        entity: id, before: { status: row.status, payloadHash: row.payload_hash },
        after: { status: updated.status, approvalId: approval.id, approverSub: user.sub, payloadHash: row.payload_hash, reason: body.reason, authTime: user.authTime.toISOString() },
        simulated: row.simulated, classification: row.classification, createdBy: "action-service" });
      await remember(trx, user, operation, keyed, key, { approvalId: approval.id }, id);
      return decided;
    });
    if (expired) throw new ActionError(409, "request_expired");
    if (!result) throw new Error("Action decision returned no result");
    return result;
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
    requester: toRequester(row),
    status: row.status, expiresAt: row.expires_at.toISOString(), simulated: row.simulated,
    classification: row.classification, ...(row.simulation_run_id ? { simulationRunId: row.simulation_run_id } : {}) };
}
const pgCode = (error: unknown): unknown => error && typeof error === "object" && "code" in error ? error.code : undefined;
const pgMessage = (error: unknown): string => error instanceof Error ? error.message : "";
function toApproval(row: ApprovalRow): ActionApproval {
  if (!row.reason) throw new Error("Approval has no reason");
  return { id: row.id, actionRequestId: row.action_request_id, approverSub: row.approver_sub, decision: row.decision, reason: row.reason,
    payloadHash: row.payload_hash, authTime: row.auth_time.toISOString(), createdAt: row.created_at.toISOString() };
}
function toRequester(row: ActionRow): ActionRequester {
  if (row.requester_kind === "person" && row.requester_ai_system_id === null) return { kind: "person" };
  if (row.requester_kind === "assistant" && row.requester_ai_system_id) return { kind: "assistant", aiSystemId: row.requester_ai_system_id };
  throw new Error("Action Request requester is inconsistent");
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
  await appendActionRequestUpdate(trx, action);
  await appendAuditEvent(trx, { orgId: user.orgId, actor: user.sub, action: "action_request.created", entity: action.id,
    before: null, after: action, simulated: body.simulated, classification: body.classification, createdBy: "action-service" });
  return action;
}
async function appendActionRequestUpdate(trx: Tx, action: Pick<ActionRequest, "id" | "orgId" | "status" | "simulated" | "classification">): Promise<void> {
  await appendWorkerEvent(trx, { id: randomUUID(), type: "action_request.updated", orgId: action.orgId, entityId: action.id,
    status: action.status, simulated: action.simulated, classification: action.classification }, "action-service");
}
interface Saved { request_hash: string; result: ToolCallDecision & { approvalId?: string }; action_request_id: string | null }
type DecisionKey = ActionDecisionCreate & { actionRequestId: string; simulated: boolean; classification: ActionClassification };
async function replay(trx: Tx, user: ActionIdentity, operation: string, body: unknown, key: string): Promise<Saved | undefined> {
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(key)) throw new ActionError(400, "validation_failed");
  const row = (await sql<Saved>`SELECT request_hash, result, action_request_id FROM app.action_check_result
    WHERE org_id = ${user.orgId} AND actor = ${user.sub} AND operation = ${operation} AND key_hash = ${digest(key)}`.execute(trx)).rows[0];
  if (row && row.request_hash !== digest(canonicalActionJson(body))) throw new ActionError(409, "idempotency_key_reused");
  return row;
}
async function remember(trx: Tx, user: ActionIdentity, operation: string, body: ActionRequestCreate | ToolCallCheck | DecisionKey, key: string, result: unknown, actionId?: string, classification: ActionClassification = body.classification) {
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
    await appendActionRequestUpdate(trx, { id: row.id, orgId, status: "rejected", simulated: row.simulated, classification: row.classification });
    await appendAuditEvent(trx, { orgId, actor: "sla-expiry", action: "action_request.expired", entity: row.id,
      before: null, after: { status: "rejected", reason: "sla_expired", escalated: true }, simulated: row.simulated, classification: row.classification, createdBy: "action-service" });
  }
  return rows.length;
}
