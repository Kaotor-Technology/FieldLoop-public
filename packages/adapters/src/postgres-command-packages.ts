import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { ActionClassification, ActionRequest, WorkerEvent } from "@fieldloop/contracts";
import { appendAuditEvent, appendWorkerEvent } from "./postgres-domain-events.js";
import { PostgresActionStore, type ActionIdentity } from "./postgres-actions.js";

type Database = Record<string, never>;
type Tx = Transaction<Database>;
export type CommandPackageExecutionStatus = "queued" | "executed" | "not_executed";
export type CommandPackageOutcomeStatus = Exclude<CommandPackageExecutionStatus, "queued">;

export interface CommandPackageOutcomeInput {
  executionStatus: CommandPackageOutcomeStatus;
  outcome: string;
}

export interface CommandPackage {
  id: string;
  actionRequestId: string;
  target: string;
  action: string;
  rationale: string;
  citations: string[];
  procedure: string;
  preconditions: string[];
  barrierId: string;
  approvalCount: number;
  actionStatus: ActionRequest["status"];
  executionStatus: CommandPackageExecutionStatus;
  outcome: string | null;
  evidenceId: string | null;
  recordedBy: string | null;
  recordedAt: string | null;
  simulated: boolean;
  classification: ActionClassification;
  createdAt: string;
  expiresAt: string;
}

export interface CommandPackagePage {
  items: CommandPackage[];
  limit: number;
  nextCursor: string | null;
}

export interface CommandPackageServicePort {
  list(user: ActionIdentity, status: CommandPackageExecutionStatus, cursor: string | undefined, limit: number): Promise<CommandPackagePage>;
  recordOutcome(user: ActionIdentity, id: string, body: CommandPackageOutcomeInput, key: string): Promise<CommandPackage>;
}

export class CommandPackageError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 503, readonly code: string) {
    super(code);
    this.name = "CommandPackageError";
  }
}

interface CommandPackageRow {
  id: string;
  action_request_id: string;
  target: string;
  action: string;
  rationale: string;
  citations: string[];
  procedure_ref: string;
  preconditions: string[];
  barrier_id: string;
  approval_count: number;
  action_status: string;
  rejection_reason: string | null;
  execution_status: CommandPackageExecutionStatus;
  outcome: string | null;
  evidence_id: string | null;
  executed_by: string | null;
  recorded_at: Date | string | null;
  simulated: boolean;
  classification: ActionClassification;
  created_at: Date | string;
  expires_at: Date | string;
  outcome_actor: string | null;
  outcome_key_hash: string | null;
  outcome_request_hash: string | null;
  payload: Record<string, unknown>;
  barrier_classification: ActionClassification;
  simulation_run_id: string | null;
}

interface CursorPosition { createdAt: string; id: string }
const classifications: readonly ActionClassification[] = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED"];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idempotencyPattern = /^[A-Za-z0-9._:-]{16,128}$/;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

export class PostgresCommandPackageStore implements CommandPackageServicePort {
  constructor(private readonly db: Kysely<Database>, private readonly simulatedOnly = true) {}

  async list(user: ActionIdentity, status: CommandPackageExecutionStatus, cursor: string | undefined, limit: number): Promise<CommandPackagePage> {
    requireOperator(user);
    authorize(user, "INTERNAL");
    if (!isExecutionStatus(status) || !Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new CommandPackageError(400, "validation_failed");
    }
    await new PostgresActionStore(this.db, this.simulatedOnly).expire(user.orgId, this.simulatedOnly);
    const position = cursor ? decodeCursor(cursor) : undefined;
    const after = position
      ? sql`AND (p.created_at, p.id) < (${position.createdAt}::timestamptz, ${position.id}::uuid)`
      : sql``;
    const statusFilter = status === "queued"
      ? sql`AND a.status IN ('open', 'in_review', 'awaiting_second', 'approved') AND a.expires_at > clock_timestamp()`
      : sql``;
    const rows = (await sql<CommandPackageRow>`SELECT p.id::text, p.action_request_id::text, p.target,
        a.payload->>'action' AS action, COALESCE(a.rationale, '') AS rationale, a.citations,
        p.procedure_ref, p.preconditions, p.barrier_id::text,
        (SELECT count(DISTINCT ap.approver_sub)::int FROM app.approval ap WHERE ap.org_id = a.org_id
          AND ap.action_request_id = a.id AND ap.decision = 'approved' AND ap.voided_at IS NULL AND ap.payload_hash = a.payload_hash) AS approval_count,
        a.status AS action_status, a.rejection_reason,
        p.execution_status, p.outcome, e.id::text AS evidence_id, p.executed_by, p.recorded_at,
        p.simulated, p.classification, p.created_at, a.expires_at, p.outcome_actor,
        p.outcome_key_hash, p.outcome_request_hash, a.payload, b.classification AS barrier_classification,
        a.simulation_run_id::text AS simulation_run_id
      FROM app.command_package p
      JOIN app.action_request a ON a.org_id = p.org_id AND a.id = p.action_request_id
      JOIN app.barrier b ON b.org_id = p.org_id AND b.id = p.barrier_id AND b.simulated = p.simulated
      LEFT JOIN app.evidence e ON e.org_id = p.org_id AND e.command_package_id = p.id
      WHERE p.org_id = ${user.orgId} AND p.execution_status = ${status}
        AND p.simulation_retired_at IS NULL AND a.simulation_retired_at IS NULL
        AND (e.id IS NULL OR e.simulation_retired_at IS NULL)
        AND array_position(ARRAY['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED']::text[], p.classification)
          >= array_position(ARRAY['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED']::text[], b.classification)
        AND array_position(ARRAY['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED']::text[], p.classification) <= ${classificationRank(user.clearance) + 1}
        AND (NOT ${this.simulatedOnly} OR p.simulated)
        ${statusFilter} ${after}
      ORDER BY p.created_at DESC, p.id DESC LIMIT ${limit + 1}`.execute(this.db)).rows;
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const items = pageRows.map(toCommandPackage);
    const last = pageRows.at(-1);
    return { items, limit, nextCursor: hasMore && last ? encodeCursor({ createdAt: toIso(last.created_at), id: last.id }) : null };
  }

  async recordOutcome(user: ActionIdentity, id: string, body: CommandPackageOutcomeInput, key: string): Promise<CommandPackage> {
    requireOperator(user);
    if (!uuidPattern.test(id) || !isOutcomeInput(body) || !idempotencyPattern.test(key)) {
      throw new CommandPackageError(400, "validation_failed");
    }
    const outcome = { executionStatus: body.executionStatus, outcome: body.outcome.trim() };
    const keyHash = digest(JSON.stringify([user.sub, key]));
    const requestHash = digest(JSON.stringify([outcome.executionStatus, outcome.outcome]));
    await new PostgresActionStore(this.db, this.simulatedOnly).expire(user.orgId, this.simulatedOnly);
    return this.db.transaction().execute(async (trx) => {
      await lockOrganisation(trx, user.orgId);
      const row = (await readCommandPackage(trx, user, id, true, this.simulatedOnly)).row;
      authorize(user, row.classification);
      authorize(user, row.barrier_classification);
      if (this.simulatedOnly && !row.simulated) throw new CommandPackageError(403, "simulation_required");

      if (row.execution_status !== "queued" || row.outcome !== null) {
        if (row.outcome_actor === user.sub && row.outcome_key_hash === keyHash) {
          if (row.outcome_request_hash !== requestHash) throw new CommandPackageError(409, "idempotency_key_reused");
          return toCommandPackage(row);
        }
        throw new CommandPackageError(409, "conflict");
      }
      if (row.rejection_reason === "sla_expired") throw new CommandPackageError(409, "action_request_expired");
      if (row.action_status !== "approved" || row.approval_count < 2) {
        if (["open", "in_review", "awaiting_second", "approved"].includes(row.action_status)) throw new CommandPackageError(409, "approval_required");
        throw new CommandPackageError(409, "conflict");
      }
      if (new Date(row.expires_at).getTime() <= Date.now()) throw new CommandPackageError(409, "action_request_expired");
      assertPayloadMatches(row);
      if (row.simulation_run_id) await sql`SELECT set_config('app.simulation_run_id', ${row.simulation_run_id}, true)`.execute(trx);
      const recordedAt = (await sql<{ recorded_at: Date }>`SELECT clock_timestamp() AS recorded_at`.execute(trx)).rows[0]?.recorded_at;
      if (!recordedAt) throw new Error("Database clock unavailable");
      const updatedPackage = await sql`UPDATE app.command_package SET execution_status = ${outcome.executionStatus},
          outcome = ${outcome.outcome}, executed_by = ${user.sub}, recorded_at = ${recordedAt}::timestamptz,
          outcome_actor = ${user.sub}, outcome_key_hash = ${keyHash}, outcome_request_hash = ${requestHash}
        WHERE org_id = ${user.orgId} AND id = ${row.id}::uuid AND execution_status = 'queued' AND outcome IS NULL`.execute(trx);
      if (BigInt(updatedPackage.numAffectedRows ?? 0) !== 1n) throw new CommandPackageError(409, "conflict");
      const actionStatus = outcome.executionStatus === "executed" ? "executed" : "rejected";
      const rejectionReason = outcome.executionStatus === "not_executed" ? "operator_not_executed" : null;
      const updatedAction = await sql`UPDATE app.action_request SET status = ${actionStatus}, rejection_reason = ${rejectionReason}
        WHERE org_id = ${user.orgId} AND id = ${row.action_request_id}::uuid AND status = 'approved'
          AND expires_at > clock_timestamp() AND simulation_retired_at IS NULL`.execute(trx);
      if (BigInt(updatedAction.numAffectedRows ?? 0) !== 1n) throw new CommandPackageError(409, "action_request_expired");

      const evidence = (await sql<{ id: string }>`INSERT INTO app.evidence
        (org_id, barrier_id, kind, source, observed_at, details, command_package_id, simulated,
         classification, created_by, simulation_run_id)
        VALUES (${user.orgId}, ${row.barrier_id}::uuid, 'command_package_outcome', 'control_room',
          ${recordedAt}::timestamptz,
          ${JSON.stringify({ commandPackageId: row.id, actionRequestId: row.action_request_id,
            target: row.target, action: row.action, procedure: row.procedure_ref,
            executionStatus: outcome.executionStatus, outcome: outcome.outcome })}::jsonb,
          ${row.id}::uuid, ${row.simulated}, ${row.classification}, ${user.sub}, ${row.simulation_run_id}::uuid)
        RETURNING id::text`.execute(trx)).rows[0];
      if (!evidence) throw new Error("Command Package Evidence was not inserted");

      const event: WorkerEvent = { id: randomUUID(), type: "evidence.created", orgId: user.orgId,
        entityId: evidence.id, barrierId: row.barrier_id, simulated: row.simulated, classification: row.classification };
      await appendWorkerEvent(trx, event, user.sub);
      await appendAuditEvent(trx, { orgId: user.orgId, actor: user.sub, action: "command_package.outcome_recorded", entity: row.id,
        before: { executionStatus: "queued", actionStatus: row.action_status },
        after: { executionStatus: outcome.executionStatus, actionStatus, outcome: outcome.outcome, evidenceId: evidence.id },
        simulated: row.simulated, classification: row.classification, createdBy: user.sub });
      const result = await readCommandPackage(trx, user, id, false, this.simulatedOnly);
      return toCommandPackage({ ...result.row, evidence_id: evidence.id });
    });
  }
}

async function readCommandPackage(trx: Tx, user: ActionIdentity, id: string, forUpdate: boolean, simulatedOnly: boolean): Promise<{ row: CommandPackageRow }> {
  const lock = forUpdate ? sql`FOR UPDATE OF p, a, b` : sql``;
  const row = (await sql<CommandPackageRow>`SELECT p.id::text, p.action_request_id::text, p.target,
      a.payload->>'action' AS action, COALESCE(a.rationale, '') AS rationale, a.citations,
      p.procedure_ref, p.preconditions, p.barrier_id::text,
      (SELECT count(DISTINCT ap.approver_sub)::int FROM app.approval ap WHERE ap.org_id = a.org_id
        AND ap.action_request_id = a.id AND ap.decision = 'approved' AND ap.voided_at IS NULL AND ap.payload_hash = a.payload_hash) AS approval_count,
      a.status AS action_status, a.rejection_reason,
      p.execution_status, p.outcome, e.id::text AS evidence_id, p.executed_by, p.recorded_at,
      p.simulated, p.classification, p.created_at, a.expires_at, p.outcome_actor,
      p.outcome_key_hash, p.outcome_request_hash, a.payload, b.classification AS barrier_classification,
      a.simulation_run_id::text AS simulation_run_id
    FROM app.command_package p
    JOIN app.action_request a ON a.org_id = p.org_id AND a.id = p.action_request_id
    JOIN app.barrier b ON b.org_id = p.org_id AND b.id = p.barrier_id AND b.simulated = p.simulated
    LEFT JOIN app.evidence e ON e.org_id = p.org_id AND e.command_package_id = p.id
    WHERE p.org_id = ${user.orgId} AND p.id = ${id}::uuid
      AND p.simulation_retired_at IS NULL AND a.simulation_retired_at IS NULL
      AND (e.id IS NULL OR e.simulation_retired_at IS NULL)
      AND array_position(ARRAY['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED']::text[], p.classification)
        >= array_position(ARRAY['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED']::text[], b.classification)
      AND (NOT ${simulatedOnly} OR p.simulated)
    ${lock}`.execute(trx)).rows[0];
  if (!row) throw new CommandPackageError(404, "not_found");
  return { row };
}

function toCommandPackage(row: CommandPackageRow): CommandPackage {
  if (!Array.isArray(row.citations) || !row.citations.every((item) => typeof item === "string")
    || !Array.isArray(row.preconditions) || !row.preconditions.every((item) => typeof item === "string")) {
    throw new Error("Stored Command Package metadata is inconsistent");
  }
  return {
    id: row.id, actionRequestId: row.action_request_id, target: row.target, action: row.action,
    rationale: row.rationale, citations: row.citations, procedure: row.procedure_ref,
    preconditions: row.preconditions, barrierId: row.barrier_id,
    approvalCount: row.approval_count,
    actionStatus: row.action_status as ActionRequest["status"], executionStatus: row.execution_status,
    outcome: row.outcome, evidenceId: row.evidence_id, recordedBy: row.executed_by,
    recordedAt: row.recorded_at === null ? null : toIso(row.recorded_at), simulated: row.simulated,
    classification: row.classification, createdAt: toIso(row.created_at), expiresAt: toIso(row.expires_at),
  };
}

function assertPayloadMatches(row: CommandPackageRow): void {
  const payload = row.payload;
  if (payload["target"] !== row.target || payload["action"] !== row.action
    || payload["procedure"] !== row.procedure_ref || payload["barrierId"] !== row.barrier_id
    || JSON.stringify(payload["preconditions"]) !== JSON.stringify(row.preconditions)) {
    throw new CommandPackageError(409, "payload_hash_mismatch");
  }
}

function authorize(user: ActionIdentity, classification: string): void {
  if (!classificationRank(user.clearance) || !classificationRank(classification)
    || classificationRank(user.clearance) < classificationRank(classification)) {
    throw new CommandPackageError(403, "forbidden");
  }
}

function requireOperator(user: ActionIdentity): void {
  if (!user.sub || user.sub.startsWith("agent:") || !user.roles.includes("fieldloop.operator")) {
    throw new CommandPackageError(user.sub ? 403 : 401, user.sub ? "forbidden" : "unauthenticated");
  }
}

function classificationRank(value: string): number {
  const index = classifications.indexOf(value as ActionClassification);
  return index < 0 ? 0 : index + 1;
}

function isExecutionStatus(value: string): value is CommandPackageExecutionStatus {
  return value === "queued" || value === "executed" || value === "not_executed";
}

function isOutcomeInput(value: unknown): value is CommandPackageOutcomeInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (input["executionStatus"] === "executed" || input["executionStatus"] === "not_executed")
    && typeof input["outcome"] === "string" && input["outcome"].trim().length > 0 && input["outcome"].trim().length <= 2000
    && Object.keys(input).length === 2;
}

async function lockOrganisation(trx: Tx, orgId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([orgId, "action_requests"])}, 0))`.execute(trx);
  await sql`SELECT org_id FROM app.simulation_workspace WHERE org_id = ${orgId} FOR SHARE`.execute(trx);
}

function toIso(value: Date | string): string { return new Date(value).toISOString(); }

function encodeCursor(position: CursorPosition): string { return Buffer.from(JSON.stringify(position), "utf8").toString("base64url"); }

function decodeCursor(cursor: string): CursorPosition {
  if (cursor.length > 512) throw new CommandPackageError(400, "validation_failed");
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!value || typeof value !== "object") throw new Error("invalid cursor");
    const createdAt = Reflect.get(value, "createdAt"), id = Reflect.get(value, "id");
    if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt)) || typeof id !== "string" || !uuidPattern.test(id)) {
      throw new Error("invalid cursor");
    }
    return { createdAt, id };
  } catch {
    throw new CommandPackageError(400, "validation_failed");
  }
}
