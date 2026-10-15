import { createHash } from "node:crypto";
import { appendAuditEvent } from "@fieldloop/adapters";
import { sql, type Kysely, type Transaction } from "kysely";
import { isRecentAuthTime, type CurrentUser } from "../auth/service.js";
import { DraftServiceError, type DraftItem, type DraftServicePort, type DraftStatus } from "./model.js";

type Database = Record<string, never>;
type Connection = Kysely<Database> | Transaction<Database>;
const CLASSIFICATIONS = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED"] as const;
type DraftClassification = typeof CLASSIFICATIONS[number];

interface DraftRow {
  id: string;
  org_id: string;
  kind: string;
  content: string | null;
  citations: unknown;
  confidence: number | string | null;
  status: string;
  approved_by: string | null;
  approved_at: Date | string | null;
  approved_auth_time: Date | string | null;
  approved_content_hash: string | null;
  decision_by_sub: string | null;
  decision_by_name: string | null;
  decision_at: Date | string | null;
  decision_auth_time: Date | string | null;
  decision_reason: string | null;
  decision_key: string | null;
  decision_hash: string | null;
  simulated: boolean;
  classification: string | null;
  created_at: Date | string;
  created_by: string | null;
}

export class PostgresDraftStore implements DraftServicePort {
  constructor(private readonly db: Kysely<Database>) {}

  async list(user: CurrentUser, status: DraftStatus, limit: number): Promise<DraftItem[]> {
    const clearance = clearanceRank(user.clearance);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DraftServiceError(400, "validation_failed");
    const rows = (await sql<DraftRow>`SELECT * FROM app.draft
      WHERE org_id = ${user.orgId} AND kind = 'management_summary' AND status = ${status}
        AND array_position(ARRAY['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED']::text[], classification) <= ${clearance + 1}
      ORDER BY created_at DESC, id DESC LIMIT ${limit}`.execute(this.db)).rows;
    return rows.map(toDraft);
  }

  async get(user: CurrentUser, draftId: string): Promise<DraftItem> {
    return readDraft(this.db, user, draftId);
  }

  async decide(input: Parameters<DraftServicePort["decide"]>[0]): Promise<DraftItem> {
    const clearance = clearanceRank(input.user.clearance);
    if (!input.user.roles.some((role) => role === "fieldloop.operator" || role === "fieldloop.manager")) {
      throw new DraftServiceError(403, "forbidden");
    }
    if (!isRecentAuthTime(input.user.authTime, new Date())) throw new DraftServiceError(403, "reauthentication_required");
    if (input.user.sub.startsWith("agent:")) throw new DraftServiceError(403, "forbidden");
    const approverName = input.user.displayName?.trim();
    if (!approverName) throw new DraftServiceError(403, "approver_name_unavailable");
    const reason = input.decision === "reject" ? input.reason?.trim() : undefined;
    if (input.decision === "reject" && (!reason || reason.length > 2000)) {
      throw new DraftServiceError(400, "validation_failed");
    }

    const keyDigest = digest(JSON.stringify([input.user.sub, input.idempotencyKey]));
    const requestDigest = digest(JSON.stringify([input.draftId, input.decision, reason ?? null]));
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([input.user.orgId, "draft_decision", keyDigest])}, 0))`.execute(trx);
      const previous = (await sql<{ id: string; decision_hash: string }>`SELECT id::text, decision_hash FROM app.draft
        WHERE org_id = ${input.user.orgId} AND decision_key = ${keyDigest}`.execute(trx)).rows[0];
      if (previous) {
        if (previous.decision_hash !== requestDigest) throw new DraftServiceError(409, "idempotency_key_reused");
        return readDraft(trx, input.user, previous.id);
      }

      const row = (await sql<DraftRow>`SELECT * FROM app.draft
        WHERE org_id = ${input.user.orgId} AND id = ${input.draftId}::uuid AND kind = 'management_summary'
        FOR UPDATE`.execute(trx)).rows[0];
      if (!row) throw new DraftServiceError(404, "not_found");
      if (!row.classification || CLASSIFICATIONS.indexOf(row.classification as DraftClassification) < 0
        || CLASSIFICATIONS.indexOf(row.classification as DraftClassification) > clearance) {
        throw new DraftServiceError(403, "forbidden");
      }
      if (row.status !== "needs_approval") throw new DraftServiceError(409, "conflict");
      if (input.decision === "approve") {
        const authorSub = draftAuthor(row.created_by);
        if (!authorSub || authorSub === input.user.sub) throw new DraftServiceError(403, "author_cannot_approve");
      }
      const content = row.content;
      const citations = readCitations(row.citations);
      if (!content) throw new DraftServiceError(409, "conflict");
      const contentHash = digest(JSON.stringify([content, citations]));
      const decisionAt = (await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(trx)).rows[0]?.now;
      if (!decisionAt) throw new Error("Database clock unavailable");
      const status = input.decision === "approve" ? "approved" : "rejected";
      const updated = (await sql<DraftRow>`UPDATE app.draft SET status = ${status},
          approved_by = ${input.decision === "approve" ? approverName : null},
          approved_by_sub = ${input.decision === "approve" ? input.user.sub : null},
          approved_at = ${input.decision === "approve" ? decisionAt : null}::timestamptz,
          approved_auth_time = ${input.decision === "approve" ? input.user.authTime : null}::timestamptz,
          approved_content_hash = ${input.decision === "approve" ? contentHash : null},
          decision_by_sub = ${input.user.sub}, decision_by_name = ${approverName}, decision_at = ${decisionAt}::timestamptz,
          decision_auth_time = ${input.user.authTime}, decision_reason = ${reason ?? null},
          decision_key = ${keyDigest}, decision_hash = ${requestDigest}
        WHERE org_id = ${input.user.orgId} AND id = ${input.draftId}::uuid AND status = 'needs_approval'
        RETURNING *`.execute(trx)).rows[0];
      if (!updated) throw new DraftServiceError(409, "conflict");

      await appendAuditEvent(trx, {
        orgId: input.user.orgId, actor: input.user.sub, action: `draft.${status}`, entity: updated.id,
        before: { status: row.status },
        after: status === "approved"
          ? { status, approvedBy: approverName, approvedAt: decisionAt.toISOString(), contentHash }
          : { status, rejectedBy: approverName, reason },
        simulated: updated.simulated, classification: updated.classification ?? "INTERNAL", createdBy: input.user.sub,
      });
      return toDraft(updated);
    });
  }
}

async function readDraft(connection: Connection, user: CurrentUser, draftId: string): Promise<DraftItem> {
  const clearance = clearanceRank(user.clearance);
  const row = (await sql<DraftRow>`SELECT * FROM app.draft
    WHERE org_id = ${user.orgId} AND id = ${draftId}::uuid AND kind = 'management_summary'`.execute(connection)).rows[0];
  if (!row) throw new DraftServiceError(404, "not_found");
  if (!row.classification || CLASSIFICATIONS.indexOf(row.classification as DraftClassification) < 0
    || CLASSIFICATIONS.indexOf(row.classification as DraftClassification) > clearance) {
    throw new DraftServiceError(403, "forbidden");
  }
  return toDraft(row);
}

function toDraft(row: DraftRow): DraftItem {
  if (row.kind !== "management_summary" || !row.content || !row.classification
    || !CLASSIFICATIONS.includes(row.classification as DraftClassification)
    || !["needs_approval", "approved", "rejected"].includes(row.status)) {
    throw new Error("Draft record is inconsistent");
  }
  const approvedAt = timestamp(row.approved_at);
  const decisionAt = timestamp(row.decision_at);
  const approvedBy = row.approved_by;
  const approvalStamp = row.status === "approved" && approvedBy && approvedAt
    ? `AI-assisted, approved by ${approvedBy}, ${approvedAt.slice(0, 10)}`
    : null;
  return {
    id: row.id, kind: "management_summary", content: row.content, citations: readCitations(row.citations),
    confidence: row.confidence === null ? null : Number(row.confidence), status: row.status as DraftStatus,
    approvedBy, approvedAt, approvalStamp, decisionBy: row.decision_by_name, decisionAt,
    decisionReason: row.decision_reason, simulated: row.simulated,
    classification: row.classification as DraftItem["classification"], createdAt: timestamp(row.created_at) ?? new Date(0).toISOString(),
    createdBy: row.created_by ?? "unknown",
  };
}

function readCitations(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((citation) => typeof citation !== "string")) {
    throw new Error("Draft citations are inconsistent");
  }
  return value as string[];
}

function timestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Draft timestamp is inconsistent");
  return date.toISOString();
}

function draftAuthor(createdBy: string | null): string | null {
  if (!createdBy) return null;
  const delegatedAuthor = /(?:^|\s)on_behalf_of:([^\s]+)/.exec(createdBy)?.[1];
  if (delegatedAuthor) return delegatedAuthor;
  return createdBy.startsWith("agent:") ? null : createdBy;
}

function clearanceRank(clearance: string): number {
  const rank = CLASSIFICATIONS.indexOf(clearance as DraftClassification);
  if (rank < 0) throw new DraftServiceError(403, "forbidden");
  return rank;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
