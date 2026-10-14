import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import * as adapters from "../src/index.js";

const input = { orgId: "org-test", actor: "synthetic-user", action: "barrier.health_changed", entity: "barrier:synthetic-1", beforeHash: null, afterHash: "a".repeat(64), simulated: true, classification: "INTERNAL" };
const appended = { event_id: "event-1", previous_hash: "b".repeat(64), event_hash: "c".repeat(64) };
const receipt = { id: "event-1", prevHash: "b".repeat(64), hash: "c".repeat(64) };
const appendValues = [input.orgId, input.actor, input.action, input.entity, null, input.afterHash, true, "INTERNAL"];

function fixture() {
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]): Promise<{ rows: (typeof appended)[] }> => {
    calls.push({ sql, values });
    return { rows: sql.includes("app.append_audit_event") ? [appended] : [] };
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  return { pool: { connect } as unknown as Pool, calls, query, release, connect };
}

function writer() {
  const append = (adapters as Record<string, unknown>)["appendAuditEventAtomically"];
  expect(typeof append, "atomic audit writer is exported").toBe("function");
  return append as (pool: Pool, event: typeof input) => Promise<{ id: string; prevHash: string | null; hash: string }>;
}

describe("atomic audit writer", () => {
  it("rolls back when the domain mutation fails without appending audit", async () => {
    const f = fixture();
    const failure = new Error("synthetic domain mutation failed");
    await expect(adapters.appendAuditEventAtomically(f.pool, input as adapters.AtomicAuditEventInput, async (transaction) => {
      await transaction.query("UPDATE synthetic_domain SET value = $1", [2]);
      throw failure;
    })).rejects.toBe(failure);
    expect(f.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(f.calls.some((call) => call.sql.includes("append_audit_event"))).toBe(false);
    expect(f.calls.some((call) => call.sql === "COMMIT")).toBe(false);
    expect(f.release).toHaveBeenCalledExactlyOnceWith();
  });

  it("rolls back the domain mutation when the audit append fails", async () => {
    const f = fixture();
    const failure = new Error("synthetic audit append failed");
    f.query.mockImplementation(async (sql, values) => {
      f.calls.push({ sql, values });
      if (sql.includes("append_audit_event")) throw failure;
      return { rows: [] };
    });
    await expect(adapters.appendAuditEventAtomically(f.pool, input as adapters.AtomicAuditEventInput, async (transaction) => {
      await transaction.query("UPDATE synthetic_domain SET value = $1", [2]);
    })).rejects.toBe(failure);
    expect(f.calls[1]?.sql).toBe("UPDATE synthetic_domain SET value = $1");
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
      return { rows: sql.includes("append_audit_event") ? [appended] : [] };
    });
    await expect(adapters.appendAuditEventAtomically(f.pool, input as adapters.AtomicAuditEventInput, async () => {
      mutations++;
    })).rejects.toBe(failure);
    expect(mutations).toBe(1);
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.calls.filter((call) => call.sql === "COMMIT")).toHaveLength(1);
  });

  it("pairs a domain mutation with the shared append on the same transaction client, audit last", async () => {
    const f = fixture();
    await expect(adapters.appendAuditEventAtomically(f.pool, input as adapters.AtomicAuditEventInput, async (transaction) => {
      await transaction.query("INSERT INTO synthetic_domain (id) VALUES ($1)", ["synthetic-1"]);
    })).resolves.toEqual(receipt);
    expect(f.connect).toHaveBeenCalledOnce();
    expect(f.calls.map((call) => call.sql)).toEqual([
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      "INSERT INTO synthetic_domain (id) VALUES ($1)",
      "SELECT event_id, previous_hash, event_hash FROM app.append_audit_event($1, $2, $3, $4, $5, $6, $7, $8)",
      "COMMIT",
    ]);
    expect(f.release).toHaveBeenCalledExactlyOnceWith();
  });

  it("appends through the shared SQL function, which owns the lock, chain and UTC hashing", async () => {
    const f = fixture();
    await expect(writer()(f.pool, input)).resolves.toEqual(receipt);
    expect(f.calls[0]?.sql).toBe("BEGIN ISOLATION LEVEL READ COMMITTED");
    expect(f.calls[1]?.sql).toContain("app.append_audit_event");
    expect(f.calls[1]?.values).toEqual(appendValues);
    expect(f.calls[2]?.sql).toBe("COMMIT");
    expect(f.calls.some((call) => /pg_advisory_xact_lock|INSERT INTO|TIME ZONE/.test(call.sql))).toBe(false);
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each(["connect", "mutation"])("keeps invocation metadata when the caller changes it during %s", async (stage) => {
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
    }
    const append = stage === "connect"
      ? writer()(f.pool, callerInput)
      : adapters.appendAuditEventAtomically(f.pool, callerInput as adapters.AtomicAuditEventInput, async () => {
        signalPending();
        await pending;
      });
    await entered;
    const changed = {
      orgId: "org-changed", actor: "synthetic-user-changed", action: "synthetic.changed",
      entity: "barrier:synthetic-2", beforeHash: "d".repeat(64), afterHash: "e".repeat(64),
      simulated: false, classification: "PUBLIC",
    };
    expect(Object.isFrozen(callerInput)).toBe(false);
    Object.assign(callerInput, changed);
    resume();
    await expect(append).resolves.toEqual(receipt);
    expect(f.calls.find((call) => call.sql.includes("append_audit_event"))?.values).toEqual(appendValues);
    expect(callerInput).toEqual(changed);
    expect(f.calls.at(-1)?.sql).toBe("COMMIT");
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
      if (sql.includes("append_audit_event")) throw appendError;
      if (sql === "ROLLBACK") throw new Error("connection lost");
      return { rows: [] };
    });
    await expect(writer()(f.pool, input)).rejects.toBe(appendError);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("fails when the append function returns no event", async () => {
    const f = fixture();
    f.query.mockImplementation(async (sql, values) => {
      f.calls.push({ sql, values });
      return { rows: [] };
    });
    await expect(writer()(f.pool, input)).rejects.toThrow("Audit append returned no event");
    expect(f.calls.at(-1)?.sql).toBe("ROLLBACK");
  });
});
