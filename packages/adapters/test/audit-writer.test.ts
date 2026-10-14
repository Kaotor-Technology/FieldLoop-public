import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import * as adapters from "../src/index.js";

const input = { orgId: "org-test", actor: "synthetic-user", action: "barrier.health_changed", entity: "barrier:synthetic-1", beforeHash: null, afterHash: "a".repeat(64), simulated: true, classification: "INTERNAL" };

function fixture() {
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]): Promise<{ rows: { id: string; prev_hash: string | null; hash: string }[] }> => {
    calls.push({ sql, values });
    return { rows: sql.includes("INSERT INTO") ? [{ id: "event-1", prev_hash: "b".repeat(64), hash: "c".repeat(64) }] : [] };
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  return { pool: { connect } as unknown as Pool, calls, query, release, connect };
}

function writer() {
  const append = (adapters as Record<string, unknown>)["appendAuditEventAtomically"];
  expect(typeof append, "shared audit writer is exported").toBe("function");
  return append as (pool: Pool, event: typeof input) => Promise<{ id: string; prevHash: string | null; hash: string }>;
}

describe("shared audit writer", () => {
  it("rolls back when the domain mutation fails without appending audit", async () => {
    const f = fixture();
    const failure = new Error("synthetic domain mutation failed");
    await expect(adapters.appendAuditEventAtomically(f.pool, input as adapters.AtomicAuditEventInput, async (transaction) => {
      await transaction.query("UPDATE synthetic_domain SET value = $1", [2]);
      throw failure;
    })).rejects.toBe(failure);
    expect(f.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(f.calls.some((call) => call.sql.includes("app.audit_event"))).toBe(false);
    expect(f.calls.some((call) => call.sql === "COMMIT")).toBe(false);
    expect(f.release).toHaveBeenCalledExactlyOnceWith();
  });

  it("rolls back the domain mutation when audit insertion fails", async () => {
    const f = fixture();
    const failure = new Error("synthetic audit insertion failed");
    f.query.mockImplementation(async (sql, values) => {
      f.calls.push({ sql, values });
      if (sql.includes("INSERT INTO app.audit_event")) throw failure;
      return { rows: [] };
    });
    await expect(adapters.appendAuditEventAtomically(f.pool, input as adapters.AtomicAuditEventInput, async (transaction) => {
      await transaction.query("UPDATE synthetic_domain SET value = $1", [2]);
    })).rejects.toBe(failure);
    expect(f.calls[3]?.sql).toBe("UPDATE synthetic_domain SET value = $1");
    expect(f.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(f.calls.some((call) => call.sql === "COMMIT")).toBe(false);
    expect(f.release).toHaveBeenCalledExactlyOnceWith();
  });

  it("does not run a domain mutation when metadata is rejected", async () => {
    const f = fixture();
    let mutated = false;
    await expect(adapters.appendAuditEventAtomically(f.pool, { ...input, actor: "" } as adapters.AtomicAuditEventInput, async () => {
      mutated = true;
    })).rejects.toThrow("Invalid audit metadata");
    expect(mutated).toBe(false);
    expect(f.connect).not.toHaveBeenCalled();
  });

  it("propagates an ambiguous commit error without retrying the mutation", async () => {
    const f = fixture();
    const failure = new Error("synthetic commit connection failure");
    let mutations = 0;
    f.query.mockImplementation(async (sql, values) => {
      f.calls.push({ sql, values });
      if (sql === "COMMIT") throw failure;
      return { rows: sql.includes("INSERT INTO") ? [{ id: "event-1", prev_hash: null, hash: "c".repeat(64) }] : [] };
    });
    await expect(adapters.appendAuditEventAtomically(f.pool, input as adapters.AtomicAuditEventInput, async () => {
      mutations++;
    })).rejects.toBe(failure);
    expect(mutations).toBe(1);
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.calls.filter((call) => call.sql === "COMMIT")).toHaveLength(1);
  });

  it("pairs a domain mutation with audit on the same transaction client", async () => {
    const f = fixture();
    await expect(adapters.appendAuditEventAtomically(f.pool, input as adapters.AtomicAuditEventInput, async (transaction) => {
      await transaction.query("INSERT INTO synthetic_domain (id) VALUES ($1)", ["synthetic-1"]);
    })).resolves.toEqual({ id: "event-1", prevHash: "b".repeat(64), hash: "c".repeat(64) });
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.calls.map((call) => call.sql.trim().split("\n")[0])).toEqual([
      "BEGIN ISOLATION LEVEL READ COMMITTED", "SET LOCAL TIME ZONE 'UTC'",
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      "INSERT INTO synthetic_domain (id) VALUES ($1)",
      "INSERT INTO app.audit_event (org_id, actor, action, entity, before_hash, after_hash,", "COMMIT",
    ]);
    expect(f.release).toHaveBeenCalledExactlyOnceWith();
  });

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

  it.each(["connect", "lock query"])("keeps invocation metadata when the caller changes it during %s", async (stage) => {
    const f = fixture();
    const callerInput = { ...input };
    let resume!: () => void;
    let signalPending!: () => void;
    const pending = new Promise<void>((resolve) => { resume = resolve; });
    const entered = new Promise<void>((resolve) => { signalPending = resolve; });
    if (stage === "connect") {
      f.connect.mockImplementation(async () => {
        signalPending();
        await pending;
        return { query: f.query, release: f.release };
      });
    } else {
      f.query.mockImplementation(async (sql, values) => {
        f.calls.push({ sql, values });
        if (sql.includes("pg_advisory_xact_lock")) {
          signalPending();
          await pending;
        }
        return { rows: sql.includes("INSERT INTO") ? [{ id: "event-1", prev_hash: "b".repeat(64), hash: "c".repeat(64) }] : [] };
      });
    }
    const append = writer()(f.pool, callerInput);
    await entered;
    const changed = {
      orgId: "org-changed", actor: "synthetic-user-changed", action: "synthetic.changed",
      entity: "barrier:synthetic-2", beforeHash: "d".repeat(64), afterHash: "e".repeat(64),
      simulated: false, classification: "PUBLIC",
    };
    expect(Object.isFrozen(callerInput)).toBe(false);
    Object.assign(callerInput, changed);
    resume();
    await expect(append).resolves.toEqual({ id: "event-1", prevHash: "b".repeat(64), hash: "c".repeat(64) });
    expect(f.calls[2]?.values).toEqual(["fieldloop:audit:org-test"]);
    expect(f.calls[3]?.values).toEqual([
      "org-test", "synthetic-user", "barrier.health_changed", "barrier:synthetic-1",
      null, "a".repeat(64), true, "INTERNAL",
    ]);
    expect(callerInput).toEqual(changed);
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
