import { createHash } from "node:crypto";
import { sql, type Kysely, type RawBuilder, type Transaction } from "kysely";
import type { WorkerEvent } from "@fieldloop/contracts";

type PostgresConnection<Database> = Kysely<Database> | Transaction<Database>;

export interface AuditEventInput {
  orgId: string;
  actor: string;
  action: string;
  entity: string;
  before: unknown | null;
  after: unknown;
  simulated: boolean;
  classification: string;
  createdBy: string;
}

export function hashAuditSnapshot(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Audit snapshots must be JSON serializable");
  return createHash("sha256").update(serialized).digest("hex");
}

export async function appendAuditEvent<Database>(connection: PostgresConnection<Database>, event: AuditEventInput): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([event.orgId, "audit_event"])}, 0))`.execute(connection);
  const previous = (await sql<{ content: string }>`SELECT to_jsonb(a)::text AS content
    FROM app.audit_event a WHERE org_id = ${event.orgId} ORDER BY created_at DESC, id DESC LIMIT 1`.execute(connection)).rows[0];
  const previousHash = previous ? createHash("sha256").update(previous.content).digest("hex") : null;
  const beforeHash = event.before === null ? null : hashAuditSnapshot(event.before);
  const afterHash = hashAuditSnapshot(event.after);
  await sql`INSERT INTO app.audit_event
    (org_id, actor, action, entity, before_hash, after_hash, prev_hash, simulated, classification, created_by, created_at)
    VALUES (${event.orgId}, ${event.actor}, ${event.action}, ${event.entity}, ${beforeHash}, ${afterHash}, ${previousHash},
      ${event.simulated}, ${event.classification}, ${event.createdBy}, clock_timestamp())`.execute(connection);
}

// Pair with the API's initial stream cursor so a subscriber cannot advance past
// an outbox row that is still uncommitted when its first watermark is read.
export async function lockWorkerEventOutbox<Database>(connection: PostgresConnection<Database>, orgId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([orgId, "worker_event_outbox"])}, 0))`.execute(connection);
}

/** Column list and one VALUES row for app.signal_event_outbox, for callers that batch outbox inserts. */
export const WORKER_EVENT_OUTBOX_COLUMNS = sql`(id, org_id, event, simulated, classification, created_by, created_at)`;

export function workerEventOutboxRow(event: WorkerEvent, createdBy: string): RawBuilder<unknown> {
  return sql`(${event.id}::uuid, ${event.orgId}, ${JSON.stringify(event)}::jsonb, ${event.simulated}, ${event.classification}, ${createdBy}, clock_timestamp())`;
}

export async function appendWorkerEvent<Database>(connection: PostgresConnection<Database>, event: WorkerEvent, createdBy: string): Promise<void> {
  await lockWorkerEventOutbox(connection, event.orgId);
  await sql`INSERT INTO app.signal_event_outbox ${WORKER_EVENT_OUTBOX_COLUMNS}
    VALUES ${workerEventOutboxRow(event, createdBy)}`.execute(connection);
}
