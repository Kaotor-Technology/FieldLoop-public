import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import * as adapters from "../src/index.js";

const input = { orgId: "org-test", actor: "synthetic-user", action: "barrier.health_changed", entity: "barrier:synthetic-1", beforeHash: null, afterHash: "a".repeat(64), simulated: true, classification: "INTERNAL" };

function fixture() {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values });
    return { rows: sql.includes("INSERT INTO") ? [{ id: "event-1", prev_hash: "b".repeat(64), hash: "c".repeat(64) }] : [] };
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  return { pool: { connect } as unknown as Pool, calls, query, release, connect };
}

function writer() {
  const append = (adapters as Record<string, unknown>)["appendAuditEvent"];
  expect(typeof append, "shared audit writer is exported").toBe("function");
  return append as (pool: Pool, event: typeof input) => Promise<{ id: string; prevHash: string | null; hash: string }>;
}

describe("shared audit writer", () => {
  it("appends a server-hashed event under the Organisation transaction lock", async () => {
    const f = fixture();
    await expect(writer()(f.pool, input)).resolves.toEqual({ id: "event-1", prevHash: "b".repeat(64), hash: "c".repeat(64) });
    expect(f.calls[0]?.sql).toBe("BEGIN ISOLATION LEVEL READ COMMITTED");
    expect(f.calls[1]?.sql).toBe("SET LOCAL TIME ZONE 'UTC'");
    expect(f.calls[2]?.sql).toContain("pg_advisory_xact_lock");
    expect(f.calls[2]?.values).toEqual(["fieldloop:audit:org-test"]);
    const insert = f.calls[3];
    expect(insert?.sql).toContain("app.payload_sha256(to_jsonb(event))");
    expect(insert?.sql).toContain("WHERE event.org_id = $1");
    expect(insert?.sql).toContain("ORDER BY event.created_at DESC, event.id DESC");
    expect(insert?.values).toEqual([input.orgId, input.actor, input.action, input.entity, null, input.afterHash, true, "INTERNAL"]);
    expect(f.calls[4]?.sql).toBe("COMMIT");
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each([
    { orgId: " " }, { actor: "" }, { action: "" }, { entity: "" },
    { beforeHash: "raw synthetic text" }, { afterHash: "b".repeat(63) },
    { afterHash: "G".repeat(64) }, { classification: "UNKNOWN" }, { simulated: undefined },
  ])("rejects invalid metadata before acquiring a database connection: %j", async (change) => {
    const f = fixture();
    await expect(writer()(f.pool, { ...input, ...change } as typeof input)).rejects.toThrow("Invalid audit metadata");
    expect(f.connect).not.toHaveBeenCalled();
  });

  it("preserves the append error and destroys a connection whose rollback fails", async () => {
    const f = fixture();
    const appendError = new Error("append failed");
    f.query.mockImplementation(async (sql) => {
      if (sql.includes("INSERT INTO")) throw appendError;
      if (sql === "ROLLBACK") throw new Error("connection lost");
      return { rows: [] };
    });
    await expect(writer()(f.pool, input)).rejects.toBe(appendError);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
  });
});
