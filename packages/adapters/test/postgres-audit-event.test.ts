import { Kysely, PostgresDialect } from "kysely";
import { describe, expect, it } from "vitest";
import { appendAuditEvent, hashAuditSnapshot } from "../src/index.js";

const row = { event_id: "event-1", previous_hash: "b".repeat(64), event_hash: "c".repeat(64) };
const event = {
  orgId: "org-test", actor: "synthetic-user", action: "health_proposal.accepted", entity: "proposal-1",
  before: { health: "healthy" }, after: { health: "degraded" }, simulated: true, classification: "INTERNAL", createdBy: "synthetic-user",
};

function harness(rows: unknown[] = [row]) {
  const statements: { sql: string; parameters: readonly unknown[] }[] = [];
  const connection = {
    processID: 1,
    query: async (sql: string, parameters: readonly unknown[] = []) => {
      statements.push({ sql: sql.replace(/\s+/g, " "), parameters });
      return { command: "SELECT", rowCount: rows.length, rows };
    },
    release: () => {},
  };
  const db = new Kysely<Record<string, never>>({ dialect: new PostgresDialect({ pool: { connect: async () => connection, end: async () => {} } as never }) });
  return { db, statements };
}

describe("appendAuditEvent (Kysely)", () => {
  it("calls the shared SQL function with snapshot digests and returns its receipt", async () => {
    const { db, statements } = harness();
    await expect(appendAuditEvent(db, event)).resolves.toEqual({ id: "event-1", prevHash: "b".repeat(64), hash: "c".repeat(64) });
    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).toContain("FROM app.append_audit_event(");
    expect(statements[0]?.sql).not.toMatch(/INSERT INTO|pg_advisory_xact_lock/);
    expect(statements[0]?.parameters).toEqual([
      "org-test", "synthetic-user", "health_proposal.accepted", "proposal-1",
      hashAuditSnapshot(event.before), hashAuditSnapshot(event.after), true, "INTERNAL", "synthetic-user",
    ]);
  });

  it("sends a null before digest for a creation event", async () => {
    const { db, statements } = harness();
    await appendAuditEvent(db, { ...event, before: null });
    expect(statements[0]?.parameters[4]).toBeNull();
  });

  it("fails when the function returns no event", async () => {
    const { db } = harness([]);
    await expect(appendAuditEvent(db, event)).rejects.toThrow("Audit append returned no event");
  });
});
