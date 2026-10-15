import { hashAuditSnapshot } from "@fieldloop/adapters";
import { sql, type Kysely } from "kysely";
import type { CurrentUser } from "../auth/service.js";
import { AuditServiceError, type AuditClassification, type AuditEventFilter, type AuditEventItem, type AuditEventPage, type AuditServicePort } from "./model.js";

const classifications = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED"] as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Microsecond-precision UTC text: created_at has microseconds, so a millisecond cursor would skip or repeat rows.
const isoMicroseconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

interface AuditRow {
  id: string; entity_type: string; entity: string; action: string; actor: string;
  before_hash: string | null; after_hash: string | null; prev_hash: string | null; hash: string;
  decision_reason: string | null; proposal_status: string | null; barrier_id: string | null;
  proposed_health: string | null; decision_health: string | null;
  created_at: string; simulated: boolean; classification: AuditClassification;
}
interface Position { createdAt: string; id: string }

export class PostgresAuditStore implements AuditServicePort {
  constructor(private readonly db: Kysely<Record<string, never>>) {}

  async listEvents(user: CurrentUser, filter: AuditEventFilter, cursor: string | undefined, limit: number): Promise<AuditEventPage> {
    const rank = classifications.indexOf(user.clearance as AuditClassification);
    if (rank < 0) throw new AuditServiceError(403, "forbidden");
    const position = cursor ? decodeCursor(cursor) : null;
    const typeFilter = filter.entityType ? sql`AND split_part(e.action, '.', 1) = ${filter.entityType}` : sql``;
    const entityFilter = filter.entityId ? sql`AND e.entity = ${filter.entityId}` : sql``;
    const after = position ? sql`AND (e.created_at, e.id) < (${position.createdAt}::timestamptz, ${position.id}::uuid)` : sql``;
    const rows = (await sql<AuditRow>`SELECT e.id::text, split_part(e.action, '.', 1) AS entity_type, e.entity, e.action, e.actor,
        e.before_hash, e.after_hash, e.prev_hash, app.audit_event_hash(e) AS hash,
        p.reason AS decision_reason, p.status AS proposal_status, p.barrier_id::text, p.proposed_health,
        p.decision_response->>'health' AS decision_health,
        to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at, e.simulated, e.classification
      FROM app.audit_event e
      LEFT JOIN app.health_proposal p ON p.org_id = e.org_id AND p.id::text = e.entity
        AND p.simulated = e.simulated AND p.decided_by = e.actor
        AND p.status IN ('accepted', 'rejected') AND e.action = 'health_proposal.' || p.status
        AND array_position(ARRAY['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED']::text[], p.classification) <= ${rank + 1}
      WHERE e.org_id = ${user.orgId}
        AND array_position(ARRAY['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED']::text[], e.classification) <= ${rank + 1}
        ${typeFilter} ${entityFilter} ${after}
      ORDER BY e.created_at DESC, e.id DESC LIMIT ${limit + 1}`.execute(this.db)).rows;
    const pageRows = rows.slice(0, limit);
    const items = pageRows.map((row): AuditEventItem => ({
      id: row.id, entityType: row.entity_type, entity: row.entity, action: row.action, actor: row.actor, reason: decisionReason(row),
      beforeHash: row.before_hash, afterHash: row.after_hash, prevHash: row.prev_hash, hash: row.hash,
      createdAt: row.created_at, simulated: row.simulated, classification: row.classification,
    }));
    const last = pageRows.at(-1);
    return { items, limit, nextCursor: rows.length > limit && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null };
  }
}

function encodeCursor(position: Position): string {
  return Buffer.from(JSON.stringify(position)).toString("base64url");
}

function decodeCursor(cursor: string): Position {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || !("createdAt" in value) || !("id" in value)
      || typeof value.createdAt !== "string" || !isoMicroseconds.test(value.createdAt) || !Number.isFinite(Date.parse(value.createdAt))
      || typeof value.id !== "string" || !uuidPattern.test(value.id)) throw new Error("invalid cursor");
    return { createdAt: value.createdAt, id: value.id };
  } catch { throw new AuditServiceError(400, "validation_failed"); }
}

// Resolve the domain reason only when it reproduces the original event snapshot.
// Audit metadata remains append-only; changed/missing/inaccessible domain rows yield null.
function decisionReason(row: AuditRow): string | null {
  if (row.decision_reason === null || !row.barrier_id) return null;
  let snapshot: unknown;
  if (row.proposal_status === "accepted" && row.decision_health) {
    snapshot = { status: "accepted", barrierId: row.barrier_id, health: row.decision_health, reason: row.decision_reason };
  } else if (row.proposal_status === "rejected" && row.proposed_health) {
    snapshot = { status: "rejected", barrierId: row.barrier_id, proposedHealth: row.proposed_health, reason: row.decision_reason };
  } else return null;
  return hashAuditSnapshot(snapshot) === row.after_hash ? row.decision_reason : null;
}
