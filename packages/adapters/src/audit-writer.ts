import type { Pool, PoolClient } from "pg";

export interface AtomicAuditEventInput {
  orgId: string;
  actor: string;
  action: string;
  entity: string;
  beforeHash: string | null;
  afterHash: string | null;
  simulated: boolean;
  classification: "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "HIGHLY_RESTRICTED";
}

export interface AuditEventReceipt {
  id: string;
  prevHash: string | null;
  hash: string;
}

/**
 * Append metadata only; callers supply digests, never raw prompts or classified payloads.
 * An optional SQL-only mutation runs on the same client before the audit append, which is the
 * shared SQL function app.append_audit_event: it takes the Organisation lock, chains prev_hash
 * and hashes in UTC. The lock is therefore taken last, after any row locks the mutation holds.
 * The writer owns transaction/session settings and connection lifecycle: the mutation
 * must not BEGIN/COMMIT/ROLLBACK, change those settings, or perform external effects.
 * Any mutation/append failure rolls back both; the receipt is returned only after COMMIT.
 */
export async function appendAuditEventAtomically(
  pool: Pool,
  input: AtomicAuditEventInput,
  mutate?: (transaction: Pick<PoolClient, "query">) => Promise<void>,
): Promise<AuditEventReceipt> {
  // Own the scalar metadata before validation and any asynchronous work.
  const snapshot: AtomicAuditEventInput = {
    orgId: input.orgId,
    actor: input.actor,
    action: input.action,
    entity: input.entity,
    beforeHash: input.beforeHash,
    afterHash: input.afterHash,
    simulated: input.simulated,
    classification: input.classification,
  };
  if ([snapshot.orgId, snapshot.actor, snapshot.action, snapshot.entity].some((value) => typeof value !== "string" || !value.trim())
    || [snapshot.beforeHash, snapshot.afterHash].some((value) => value !== null && (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)))
    || typeof snapshot.simulated !== "boolean"
    || !["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED"].includes(snapshot.classification)) {
    throw new Error("Invalid audit metadata");
  }
  const client = await pool.connect();
  let discardConnection = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    if (mutate) await mutate({ query: client.query.bind(client) });
    const result = await client.query<{ event_id: string; previous_hash: string | null; event_hash: string }>(
      "SELECT event_id, previous_hash, event_hash FROM app.append_audit_event($1, $2, $3, $4, $5, $6, $7, $8)",
      [snapshot.orgId, snapshot.actor, snapshot.action, snapshot.entity, snapshot.beforeHash, snapshot.afterHash, snapshot.simulated, snapshot.classification],
    );
    const event = result.rows[0];
    if (!event) throw new Error("Audit append returned no event");
    await client.query("COMMIT");
    return { id: event.event_id, prevHash: event.previous_hash, hash: event.event_hash };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      discardConnection = true;
    }
    throw error;
  } finally {
    if (discardConnection) client.release(true);
    else client.release();
  }
}
