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

/** Identity of an audit event for reconciliation after an unknown COMMIT outcome. */
export interface AuditEventLookup {
  orgId: string;
  action: string;
  entity: string;
  afterHash: string | null;
}

/**
 * COMMIT failed without a server verdict (connection lost or timed out), so the mutation and its
 * audit row are either both committed or both absent. Never retry the mutation blindly: reconcile
 * with findCommittedAuditEvent(pool, error.lookup, windowSeconds) or the domain's own idempotency key.
 */
export class AuditCommitUnknownError extends Error {
  readonly lookup: AuditEventLookup;
  constructor(lookup: AuditEventLookup, cause: unknown) {
    super("Audit COMMIT outcome is unknown; reconcile before retrying", { cause });
    this.name = "AuditCommitUnknownError";
    this.lookup = lookup;
  }
}

// A server verdict carries a five-character SQLSTATE; connection and timeout errors do not.
function isServerError(error: unknown): boolean {
  return typeof error === "object" && error !== null && /^[0-9A-Z]{5}$/.test(String(Reflect.get(error, "code")));
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
    try {
      await client.query("COMMIT");
    } catch (error) {
      if (isServerError(error)) throw error;
      // No verdict: the connection state is unknown, so never reuse it and never claim a rollback.
      discardConnection = true;
      throw new AuditCommitUnknownError({ orgId: snapshot.orgId, action: snapshot.action, entity: snapshot.entity, afterHash: snapshot.afterHash }, error);
    }
    return { id: event.event_id, prevHash: event.previous_hash, hash: event.event_hash };
  } catch (error) {
    if (error instanceof AuditCommitUnknownError) throw error;
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

/**
 * Find the audit event that an unknown COMMIT may have written. Because the mutation and the audit
 * row commit together, a match proves the mutation committed; no match after the connection is
 * healthy again proves neither was. The window is relative to the database clock. More than one
 * match is ambiguous (the same event repeated inside the window) and must be settled with the
 * domain's idempotency key, so it throws.
 */
export async function findCommittedAuditEvent(pool: Pool, lookup: AuditEventLookup, windowSeconds: number): Promise<AuditEventReceipt | null> {
  if (!Number.isInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 3600) throw new Error("Invalid reconciliation window");
  const result = await pool.query<{ event_id: string; previous_hash: string | null; event_hash: string }>(
    `SELECT e.id AS event_id, e.prev_hash AS previous_hash, app.audit_event_hash(e) AS event_hash
     FROM app.audit_event AS e
     WHERE e.org_id = $1 AND e.action = $2 AND e.entity = $3 AND e.after_hash IS NOT DISTINCT FROM $4
       AND e.created_at >= clock_timestamp() - make_interval(secs => $5)
     ORDER BY e.created_at, e.id LIMIT 2`,
    [lookup.orgId, lookup.action, lookup.entity, lookup.afterHash, windowSeconds],
  );
  if (result.rows.length > 1) throw new Error("Audit reconciliation is ambiguous; use the domain idempotency key");
  const event = result.rows[0];
  return event ? { id: event.event_id, prevHash: event.previous_hash, hash: event.event_hash } : null;
}
