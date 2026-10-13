import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import { appendAuditEvent, appendWorkerEvent } from "@fieldloop/adapters";
import { isWorkerEvent, type WorkerEvent } from "@fieldloop/contracts";
import type { CurrentUser } from "../auth/service.js";
import { HealthServiceError, type EventPosition, type HealthDecision, type HealthDecisionResult, type NotificationItem, type NotificationPage, type HealthServicePort, type StoredHealthEvent } from "./model.js";

type Database = Record<string, never>;
type Connection = Kysely<Database> | Transaction<Database>;
const classifications = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED"] as const;
type Classification = typeof classifications[number];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ProposalRow {
  id: string; status: string; proposed_health: string; simulated: boolean; simulation_run_id: string | null;
  proposal_classification: string; barrier_id: string; barrier_health: string; owner_id: string | null;
  barrier_simulated: boolean; barrier_classification: string; current_user_id: string | null;
}
interface NotificationRow {
  id: string; subject_type: NotificationItem["subjectType"]; subject_id: string; barrier_id: string | null;
  channel: string; status: string; created_at: string; simulated: boolean; classification: string;
}
interface StoredEventRow { id: string; created_at: string; event: unknown; }

export class PostgresHealthStore implements HealthServicePort {
  constructor(private readonly db: Kysely<Database>) {}

  async decide(input: {
    user: CurrentUser; proposalId: string; decision: HealthDecision; reason: string; idempotencyKey: string;
  }): Promise<HealthDecisionResult> {
    requireHealthRole(input.user);
    const keyDigest = digest(JSON.stringify([input.user.sub, input.idempotencyKey]));
    const bodyDigest = digest(JSON.stringify([input.proposalId, input.decision, input.reason]));
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([input.user.orgId, input.user.sub, keyDigest])}, 0))`.execute(trx);
      const previous = (await sql<{ decision_hash: string; decision_response: HealthDecisionResult }>`SELECT decision_hash, decision_response
        FROM app.health_proposal WHERE org_id = ${input.user.orgId} AND decided_by = ${input.user.sub}
          AND decision_key = ${keyDigest}`.execute(trx)).rows[0];
      if (previous) {
        if (previous.decision_hash !== bodyDigest) throw new HealthServiceError(409, "idempotency_key_reused");
        return previous.decision_response;
      }

      const row = (await sql<ProposalRow>`SELECT p.id, p.status, p.proposed_health, p.simulated, p.simulation_run_id,
          p.classification AS proposal_classification, b.id AS barrier_id, b.health AS barrier_health,
          b.owner_id, b.simulated AS barrier_simulated, b.classification AS barrier_classification,
          u.id AS current_user_id
        FROM app.health_proposal p
        JOIN app.barrier b ON b.org_id = p.org_id AND b.id = p.barrier_id AND b.simulated = p.simulated
        LEFT JOIN app.app_user u ON u.org_id = p.org_id AND u.keycloak_sub = ${input.user.sub}
        WHERE p.org_id = ${input.user.orgId} AND p.id = ${input.proposalId}::uuid
          AND p.simulation_retired_at IS NULL
        FOR UPDATE OF p, b`.execute(trx)).rows[0];
      if (!row) throw new HealthServiceError(404, "not_found");
      if (!row.current_user_id || row.owner_id !== row.current_user_id) throw new HealthServiceError(403, "forbidden");
      if (row.status !== "open") throw new HealthServiceError(409, "conflict");
      const classification = maximumClassification(row.proposal_classification, row.barrier_classification);
      if (!permits(input.user.clearance, classification)) throw new HealthServiceError(403, "forbidden");
      const health = input.decision === "accept" ? validHealth(row.proposed_health) : row.barrier_health;
      const status = input.decision === "accept" ? "accepted" : "rejected";
      const result: HealthDecisionResult = { healthProposalId: row.id, status, barrierId: row.barrier_id, health };

      if (row.simulation_run_id) {
        await sql`SELECT set_config('app.simulation_run_id', ${row.simulation_run_id}, true)`.execute(trx);
      }
      if (input.decision === "accept") {
        const updated = await sql`UPDATE app.barrier SET health = ${health}
          WHERE org_id = ${input.user.orgId} AND id = ${row.barrier_id}::uuid AND simulated = ${row.simulated}
            AND health IS NOT DISTINCT FROM ${row.barrier_health}`.execute(trx);
        if (BigInt(updated.numAffectedRows ?? 0) !== 1n) throw new HealthServiceError(409, "conflict");
        const change = (await sql<{ id: string }>`INSERT INTO app.health_change
          (org_id, barrier_id, from_health, to_health, reason, actor, simulated, classification, created_by)
          VALUES (${input.user.orgId}, ${row.barrier_id}::uuid, ${row.barrier_health}, ${health}, ${input.reason}, 'proposal',
            ${row.simulated}, ${classification}, ${input.user.sub}) RETURNING id`.execute(trx)).rows[0];
        if (!change) throw new Error("Health change insert returned no identity");
        await appendAuditEvent(trx, {
          orgId: input.user.orgId, actor: input.user.sub, action: "health_proposal.accepted", entity: row.id,
          before: { status: row.status, barrierId: row.barrier_id, health: row.barrier_health },
          after: { status, barrierId: row.barrier_id, health, reason: input.reason },
          simulated: row.simulated, classification, createdBy: input.user.sub,
        });
        const event: WorkerEvent = { id: randomUUID(), type: "barrier.health_changed", orgId: input.user.orgId,
          entityId: change.id, barrierId: row.barrier_id, simulated: row.simulated, classification };
        await appendWorkerEvent(trx, event, input.user.sub);
        if (row.owner_id && row.barrier_health !== health && ["degraded", "failed"].includes(health)) {
          await this.notifyOwner(trx, { orgId: input.user.orgId, ownerId: row.owner_id, healthChangeId: change.id,
            barrierId: row.barrier_id, simulated: row.simulated, classification, createdBy: input.user.sub });
        }
      } else {
        await appendAuditEvent(trx, {
          orgId: input.user.orgId, actor: input.user.sub, action: "health_proposal.rejected", entity: row.id,
          before: { status: row.status, barrierId: row.barrier_id, proposedHealth: row.proposed_health },
          after: { status, barrierId: row.barrier_id, proposedHealth: row.proposed_health, reason: input.reason },
          simulated: row.simulated, classification, createdBy: input.user.sub,
        });
      }
      await sql`UPDATE app.health_proposal SET status = ${status}, decided_by = ${input.user.sub}, reason = ${input.reason},
        decision_key = ${keyDigest}, decision_hash = ${bodyDigest}, decision_response = ${JSON.stringify(result)}::jsonb
        WHERE org_id = ${input.user.orgId} AND id = ${row.id}::uuid`.execute(trx);
      return result;
    });
  }

  async listNotifications(user: CurrentUser, cursor: string | undefined, limit: number): Promise<NotificationPage> {
    const userId = await this.userId(user);
    if (!userId) return { items: [], limit, nextCursor: null };
    const position = cursor ? decodeCursor(cursor) : null;
    const after = position
      ? sql`AND (n.created_at, n.id) < (${position.createdAt}::timestamptz, ${position.id}::uuid)`
      : sql``;
    const rows = (await sql<NotificationRow>`SELECT n.id::text, CASE
          WHEN n.health_change_id IS NOT NULL THEN 'health_change'
          WHEN n.evidence_id IS NOT NULL THEN 'evidence' ELSE 'action_request' END AS subject_type,
        COALESCE(n.health_change_id, n.evidence_id, n.action_request_id)::text AS subject_id,
        COALESCE(hc.barrier_id, e.barrier_id)::text AS barrier_id, n.channel, n.status,
        n.created_at::text AS created_at, n.simulated, n.classification
      FROM app.notification n
      LEFT JOIN app.health_change hc ON hc.org_id = n.org_id AND hc.id = n.health_change_id
      LEFT JOIN app.evidence e ON e.org_id = n.org_id AND e.id = n.evidence_id
      WHERE n.org_id = ${user.orgId} AND n.channel = 'in_app' AND n.simulation_retired_at IS NULL
        AND n.recipient_ref IN (${userId}, ${`sandbox:${userId}`})
        AND array_position(ARRAY['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED']::text[], n.classification) <= ${classificationRank(user.clearance)}
        AND (n.evidence_id IS NULL OR EXISTS (
          SELECT 1 FROM app.evidence current_evidence
          WHERE current_evidence.org_id = n.org_id AND current_evidence.id = n.evidence_id
            AND current_evidence.simulation_retired_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM app.evidence newer WHERE newer.org_id = current_evidence.org_id
                AND newer.barrier_id = current_evidence.barrier_id AND newer.simulated = current_evidence.simulated
                AND newer.simulation_retired_at IS NULL
                AND (newer.observed_at, newer.id) > (current_evidence.observed_at, current_evidence.id)
            )
        )) ${after}
      ORDER BY n.created_at DESC, n.id DESC LIMIT ${limit + 1}`.execute(this.db)).rows;
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const items = pageRows.map((row): NotificationItem => ({
      id: row.id, subjectType: row.subject_type, subjectId: row.subject_id, barrierId: row.barrier_id,
      channel: row.channel, status: row.status, createdAt: new Date(row.created_at).toISOString(), simulated: row.simulated,
      classification: row.classification,
    }));
    const last = pageRows.at(-1);
    return { items, limit, nextCursor: hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null };
  }

  async latestEventPosition(user: CurrentUser): Promise<EventPosition> {
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([user.orgId, "worker_event_outbox"])}, 0))`.execute(trx);
      const row = (await sql<EventPosition>`SELECT clock_timestamp()::text AS "createdAt",
        '00000000-0000-0000-0000-000000000000'::text AS id`.execute(trx)).rows[0];
      if (!row) throw new Error("Database clock did not return an event cursor");
      return row;
    });
  }

  async listEvents(user: CurrentUser, after: EventPosition | null, limit: number): Promise<StoredHealthEvent[]> {
    const positionFilter = after
      ? sql`AND (o.created_at, o.id) > (${after.createdAt}::timestamptz, ${after.id}::uuid)`
      : sql``;
    const rows = (await sql<StoredEventRow>`SELECT o.id::text, o.created_at::text AS created_at, o.event
      FROM app.signal_event_outbox o WHERE o.org_id = ${user.orgId}
        AND array_position(ARRAY['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED']::text[], o.classification) <= ${classificationRank(user.clearance)}
        AND (o.event->>'type' <> 'notification.delivered' OR EXISTS (
          SELECT 1 FROM app.current_notification n WHERE n.org_id = o.org_id
            AND n.id::text = o.event->>'entityId'
            AND n.recipient_ref IN (
              SELECT u.id::text FROM app.app_user u WHERE u.org_id = ${user.orgId} AND u.keycloak_sub = ${user.sub}
              UNION ALL
              SELECT 'sandbox:' || u.id::text FROM app.app_user u WHERE u.org_id = ${user.orgId} AND u.keycloak_sub = ${user.sub}
            )
        )) ${positionFilter}
      ORDER BY o.created_at, o.id LIMIT ${limit}`.execute(this.db)).rows;
    const result: StoredHealthEvent[] = [];
    for (const row of rows) {
      if (!isWorkerEvent(row.event)) continue;
      result.push({ position: { createdAt: row.created_at, id: row.id }, event: row.event });
    }
    return result;
  }

  private async userId(user: CurrentUser): Promise<string | undefined> {
    const row = (await sql<{ id: string }>`SELECT id::text AS id FROM app.app_user
      WHERE org_id = ${user.orgId} AND keycloak_sub = ${user.sub}`.execute(this.db)).rows[0];
    return row?.id;
  }

  private async notifyOwner(connection: Connection, input: {
    orgId: string; ownerId: string; healthChangeId: string; barrierId: string;
    simulated: boolean; classification: Classification; createdBy: string;
  }): Promise<void> {
    const id = randomUUID();
    const recipient = input.simulated ? `sandbox:${input.ownerId}` : input.ownerId;
    const inserted = await sql`INSERT INTO app.notification
      (id, org_id, health_change_id, channel, recipient_ref, status, receipt, sandbox, simulated, classification, created_by)
      VALUES (${id}::uuid, ${input.orgId}, ${input.healthChangeId}::uuid, 'in_app', ${recipient}, 'delivered',
        ${JSON.stringify({ deliveredAt: new Date().toISOString() })}::jsonb, ${input.simulated}, ${input.simulated},
        ${input.classification}, ${input.createdBy}) ON CONFLICT DO NOTHING`.execute(connection);
    if (BigInt(inserted.numAffectedRows ?? 0) !== 1n) return;
    const event: WorkerEvent = { id: randomUUID(), type: "notification.delivered", orgId: input.orgId,
      entityId: id, barrierId: input.barrierId, simulated: input.simulated, classification: input.classification };
    await appendWorkerEvent(connection, event, input.createdBy);
  }
}

function requireHealthRole(user: CurrentUser): void {
  if (!user.roles.some((role) => role === "fieldloop.operator" || role === "fieldloop.manager")) {
    throw new HealthServiceError(403, "forbidden");
  }
}
function validHealth(value: string): string {
  if (!["healthy", "degraded", "failed", "unverified"].includes(value)) throw new Error("Health Proposal contains an invalid Health value");
  return value;
}
function maximumClassification(...values: string[]): Classification {
  const valid = values.map((value) => classifications.indexOf(value as Classification));
  if (valid.some((rank) => rank < 0)) throw new Error("Health record has an invalid classification");
  return classifications[Math.max(...valid)] ?? "INTERNAL";
}
function classificationRank(value: string): number {
  return classifications.indexOf(value as Classification);
}
function permits(clearance: string, classification: string): boolean {
  return classificationRank(clearance) >= classificationRank(classification) && classificationRank(classification) >= 0;
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function encodeCursor(position: EventPosition): string {
  return Buffer.from(JSON.stringify(position)).toString("base64url");
}
function decodeCursor(cursor: string): EventPosition {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || !("createdAt" in value) || !("id" in value)
      || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
      || typeof value.id !== "string" || !uuidPattern.test(value.id)) throw new Error("invalid cursor");
    return { createdAt: value.createdAt, id: value.id };
  } catch { throw new HealthServiceError(400, "validation_failed"); }
}
