import { createHash } from "node:crypto";
import { sql, type Kysely, type RawBuilder, type Transaction } from "kysely";
import type { WorkerEvent } from "@fieldloop/contracts";
import type { AuditEventReceipt } from "./audit-writer.js";

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

/**
 * Append one audit event through app.append_audit_event, which owns the Organisation lock, the
 * hash chain and the UTC hashing. Call it last in the transaction, after domain row locks, and
 * only on a READ COMMITTED transaction (the function rejects any other level).
 */
export async function appendAuditEvent<Database>(connection: PostgresConnection<Database>, event: AuditEventInput): Promise<AuditEventReceipt> {
  const beforeHash = event.before === null ? null : hashAuditSnapshot(event.before);
  const afterHash = hashAuditSnapshot(event.after);
  const receipt = (await sql<{ event_id: string; previous_hash: string | null; event_hash: string }>`SELECT event_id, previous_hash, event_hash
    FROM app.append_audit_event(${event.orgId}, ${event.actor}, ${event.action}, ${event.entity}, ${beforeHash}, ${afterHash},
      ${event.simulated}, ${event.classification}, ${event.createdBy})`.execute(connection)).rows[0];
  if (!receipt) throw new Error("Audit append returned no event");
  return { id: receipt.event_id, prevHash: receipt.previous_hash, hash: receipt.event_hash };
}

// Pair with the API's initial stream cursor so a subscriber cannot advance past
// an outbox row that is still uncommitted when its first watermark is read.
export async function lockWorkerEventOutbox<Database>(connection: PostgresConnection<Database>, orgId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([orgId, "worker_event_outbox"])}, 0))`.execute(connection);
}

export function workerEventOutboxRow(event: WorkerEvent, createdBy: string): RawBuilder<unknown> {
  return sql`(${event.id}::uuid, ${event.orgId}, ${JSON.stringify(event)}::jsonb, ${event.simulated}, ${event.classification}, ${createdBy}, clock_timestamp())`;
}

/** INSERT for one or more outbox rows; usable as a statement or inside a data-modifying CTE. The caller holds the outbox lock. */
export function insertWorkerEventOutbox(rows: readonly RawBuilder<unknown>[]): RawBuilder<unknown> {
  return sql`INSERT INTO app.signal_event_outbox (id, org_id, event, simulated, classification, created_by, created_at)
    VALUES ${sql.join(rows)}`;
}

export async function appendWorkerEvent<Database>(connection: PostgresConnection<Database>, event: WorkerEvent, createdBy: string): Promise<void> {
  await lockWorkerEventOutbox(connection, event.orgId);
  await insertWorkerEventOutbox([workerEventOutboxRow(event, createdBy)]).execute(connection);
}
