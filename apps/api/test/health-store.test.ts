import { Kysely, PostgresDialect } from "kysely";
import { expect, it } from "vitest";
import type { CurrentUser } from "../src/auth/service.js";
import { PostgresHealthStore } from "../src/health/postgres-store.js";

const user: CurrentUser = {
  sub: "synthetic-owner",
  roles: ["fieldloop.operator"],
  persona: "Integrity Engineer",
  orgId: "synthetic-org",
  clearance: "HIGHLY_RESTRICTED",
  csrfToken: "fixture-csrf",
  authTime: new Date("2026-10-13T00:00:00Z"),
};

const proposalId = "00000000-0000-4000-8000-000000000083";
const barrierId = "00000000-0000-4000-8000-000000000183";
const changeId = "00000000-0000-4000-8000-000000000283";

function harness(overrides: { ownerId?: string | null; status?: string } = {}) {
  const statements: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  const proposal = {
    id: proposalId,
    status: overrides.status ?? "open",
    proposed_health: "degraded",
    simulated: true,
    simulation_run_id: null,
    proposal_classification: "CONFIDENTIAL",
    barrier_id: barrierId,
    barrier_health: "healthy",
    owner_id: overrides.ownerId === undefined ? "owner-user-id" : overrides.ownerId,
    barrier_simulated: true,
    barrier_classification: "CONFIDENTIAL",
    current_user_id: "owner-user-id",
  };
  const connection = {
    processID: 1,
    query: async (query: string, parameters: readonly unknown[] = []) => {
      const statement = query.replace(/\s+/g, " ");
      statements.push({ sql: statement, parameters });
      if (statement.includes("FROM app.health_proposal p") && statement.includes("FOR UPDATE OF p, b")) {
        return { command: "SELECT", rowCount: 1, rows: [proposal] };
      }
      if (statement.includes("UPDATE app.barrier SET health")) return { command: "UPDATE", rowCount: 1, rows: [] };
      if (statement.includes("INSERT INTO app.health_change")) return { command: "INSERT", rowCount: 1, rows: [{ id: changeId }] };
      if (statement.includes("INSERT INTO app.notification")) return { command: "INSERT", rowCount: 0, rows: [] };
      if (statement.includes("INSERT INTO")) return { command: "INSERT", rowCount: 1, rows: [] };
      if (statement.includes("UPDATE")) return { command: "UPDATE", rowCount: 1, rows: [] };
      return { command: "SELECT", rowCount: 0, rows: [] };
    },
    release: () => {},
  };
  const pool = { connect: async () => connection, end: async () => {} };
  const db = new Kysely<Record<string, never>>({ dialect: new PostgresDialect({ pool: pool as never }) });
  return { store: new PostgresHealthStore(db), statements };
}

function decision(store: PostgresHealthStore) {
  return store.decide({ user, proposalId, decision: "accept", reason: "Synthetic owner review.", idempotencyKey: "health-decision-0001" });
}

it("persists an accepted Health decision and emits its Health event in one transaction", async () => {
  const test = harness();

  await expect(decision(test.store)).resolves.toMatchObject({
    healthProposalId: proposalId,
    status: "accepted",
    barrierId,
    health: "degraded",
  });

  expect(test.statements[0]?.sql).toBe("begin");
  expect(test.statements.at(-1)?.sql).toBe("commit");
  expect(test.statements.some(({ sql }) => sql.includes("UPDATE app.barrier SET health"))).toBe(true);
  expect(test.statements.some(({ sql }) => sql.includes("INSERT INTO app.health_change"))).toBe(true);
  expect(test.statements.some(({ sql, parameters }) =>
    sql.includes("INSERT INTO app.audit_event") && parameters.includes("health_proposal.accepted"))).toBe(true);
  expect(test.statements.some(({ sql, parameters }) => {
    const event = parameters.find((value) => typeof value === "string" && value.includes("barrier.health_changed"));
    return sql.includes("INSERT INTO app.signal_event_outbox") && typeof event === "string"
      && JSON.parse(event).health === "degraded";
  })).toBe(true);
  expect(test.statements.some(({ sql }) => sql.includes("UPDATE app.health_proposal SET status"))).toBe(true);
});

it("returns 403 when an operator is not the Barrier Owner", async () => {
  const test = harness({ ownerId: "another-user-id" });

  await expect(decision(test.store)).rejects.toMatchObject({ status: 403, code: "forbidden" });
  expect(test.statements[0]?.sql).toBe("begin");
  expect(test.statements.at(-1)?.sql).toBe("rollback");
  expect(test.statements.some(({ sql }) => sql.startsWith("UPDATE ") || sql.startsWith("INSERT INTO"))).toBe(false);
});

it("returns 409 when a Health Proposal is no longer open", async () => {
  const test = harness({ status: "superseded" });

  await expect(decision(test.store)).rejects.toMatchObject({ status: 409, code: "conflict" });
  expect(test.statements[0]?.sql).toBe("begin");
  expect(test.statements.at(-1)?.sql).toBe("rollback");
  expect(test.statements.some(({ sql }) => sql.startsWith("UPDATE ") || sql.startsWith("INSERT INTO"))).toBe(false);
});
