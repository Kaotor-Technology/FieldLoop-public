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
 * An optional SQL-only mutation runs on the same client before the audit INSERT.
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
    // timestamptz JSON is session-dependent. Pin hashing to UTC within this transaction only.
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    // Every service uses the same transaction lock. The next statement gets a fresh snapshot
    // after a concurrent writer commits, including when the pool default is REPEATABLE READ.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`fieldloop:audit:${snapshot.orgId}`]);
    if (mutate) await mutate({ query: client.query.bind(client) });
    const result = await client.query<{ id: string; prev_hash: string | null; hash: string }>(`
      INSERT INTO app.audit_event (org_id, actor, action, entity, before_hash, after_hash,
        prev_hash, simulated, classification, created_at, created_by)
      SELECT $1, $2, $3, $4, $5, $6, predecessor.hash, $7, $8,
        GREATEST(clock_timestamp(), predecessor.created_at + interval '1 microsecond'), $2
      FROM (SELECT 1) AS seed
      LEFT JOIN LATERAL (
        SELECT app.payload_sha256(to_jsonb(event)) AS hash, event.created_at
        FROM app.audit_event AS event WHERE event.org_id = $1
        ORDER BY event.created_at DESC, event.id DESC LIMIT 1
      ) AS predecessor ON true
      RETURNING id, prev_hash, app.payload_sha256(to_jsonb(audit_event)) AS hash
    `, [snapshot.orgId, snapshot.actor, snapshot.action, snapshot.entity, snapshot.beforeHash, snapshot.afterHash, snapshot.simulated, snapshot.classification]);
    const event = result.rows[0];
    if (!event) throw new Error("Audit append returned no event");
    await client.query("COMMIT");
    return { id: event.id, prevHash: event.prev_hash, hash: event.hash };
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
