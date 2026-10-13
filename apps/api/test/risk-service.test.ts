import { describe, expect, it } from "vitest";
import type { RiskMatrix } from "@fieldloop/contracts";
import type { Pool } from "pg";
import { PostgresRiskService, RiskServiceError } from "../src/risk/service.js";
import type { CurrentUser } from "../src/auth/service.js";

const ids = {
  bowtie: "10000000-0000-4000-8000-000000000001",
  threat: "10000000-0000-4000-8000-000000000002",
  consequence: "10000000-0000-4000-8000-000000000003",
  preventiveBarrier: "10000000-0000-4000-8000-000000000004",
  mitigativeBarrier: "10000000-0000-4000-8000-000000000005",
};

const user: CurrentUser = {
  sub: "synthetic-reviewer", roles: ["fieldloop.viewer"], persona: "Executive", orgId: "synthetic-org",
  clearance: "INTERNAL", csrfToken: "fixture-csrf", authTime: new Date("2026-10-13T00:00:00Z"),
};

function matrix(): RiskMatrix {
  return {
    frequencyThresholds: [0.0001, 0.001, 0.01, 0.1],
    cells: Array.from({ length: 5 }, (_, row) => Array.from({ length: 5 }, (_, column) => {
      const rank = row * 5 + column + 1;
      return { rank, zone: (rank < 10 ? "green" : rank < 20 ? "amber" : "red") as "green" | "amber" | "red" };
    })),
  };
}

const criteria = {
  people: ["p1", "p2", "p3", "p4", "p5"], environment: ["e1", "e2", "e3", "e4", "e5"],
  financial: ["f1", "f2", "f3", "f4", "f5"], serviceContinuity: ["s1", "s2", "s3", "s4", "s5"],
  reputation: ["r1", "r2", "r3", "r4", "r5"], legalRegulatory: ["l1", "l2", "l3", "l4", "l5"],
};

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sortJson(entry)]),
  );
  return value;
}

interface FakeHealthChange {
  id: string;
  barrierId: string;
  createdAt: string;
  fromHealth: string | null;
  toHealth: string;
  reason: string;
}

function fixture(approved = true, healthChanges: FakeHealthChange[] = []) {
  const snapshots: Record<string, unknown>[] = [];
  let nextId = 1;
  let health = "healthy";
  const paths = [
    { id: "20000000-0000-4000-8000-000000000001", position: 1, threat_id: ids.threat, consequence_id: null, path_classification: "PUBLIC", barrier_id: ids.preventiveBarrier, type: "technical", side: "preventive", pfd_band: 0.01, independence_group_id: null, evidence_interval: null, barrier_classification: "PUBLIC" },
    { id: "20000000-0000-4000-8000-000000000002", position: 2, threat_id: null, consequence_id: ids.consequence, path_classification: "PUBLIC", barrier_id: ids.mitigativeBarrier, type: "technical", side: "mitigative", pfd_band: 0.01, independence_group_id: null, evidence_interval: null, barrier_classification: "PUBLIC" },
  ];
  const pool = {
    query: async (statement: string, values: unknown[] = []) => {
      const sql = statement.replace(/\s+/g, " ").trim();
      if (sql.includes("FROM app.bowtie WHERE")) return { rows: [{ id: ids.bowtie, hazard: "Synthetic hazard", top_event: "Synthetic top event", domain: "pipeline", status: "active", simulated: false, classification: "PUBLIC" }] };
      if (sql.startsWith("SELECT hc.id, hc.org_id, hc.barrier_id")) return { rows: healthChanges
        .filter((change) => !snapshots.some((snapshot) => snapshot.health_change_id === change.id))
        .map((change) => ({
          id: change.id, org_id: user.orgId, barrier_id: change.barrierId, actor: "synthetic-reviewer",
          from_health: change.fromHealth, to_health: change.toHealth, created_at: new Date(change.createdAt),
          simulated: false, classification: "PUBLIC",
        })) };
      if (sql.includes("FROM app.organisation")) return { rows: approved ? [{
        risk_matrix: matrix(), risk_severity_criteria: criteria, risk_matrix_approved_at: new Date("2026-10-13T00:00:00Z"),
        risk_matrix_approved_by: "synthetic-authority", classification: "PUBLIC",
      }] : [{ risk_matrix: null, risk_severity_criteria: null, risk_matrix_approved_at: null, risk_matrix_approved_by: null, classification: "PUBLIC" }] };
      if (sql.startsWith("SELECT id, frequency_per_year, classification FROM app.threat")) return { rows: [{ id: ids.threat, name: "Synthetic threat", frequency_per_year: 0.1, classification: "PUBLIC" }] };
      if (sql.startsWith("SELECT id, severity, p_conditional, classification FROM app.consequence")) return { rows: [{ id: ids.consequence, name: "Synthetic consequence", severity: { people: 3, environment: 2, financial: 2 }, p_conditional: 1, classification: "PUBLIC" }] };
      if (sql.startsWith("SELECT id, classification FROM app.independence_group")) return { rows: [] };
      if (sql.startsWith("SELECT bp.id AS path_row_id")) return { rows: paths.map((path) => ({ ...path, health: path.barrier_id === ids.preventiveBarrier ? health : "healthy" })) };
      if (sql.includes("SELECT DISTINCT ON (barrier_id)")) return { rows: [] };
      if (sql.startsWith("SELECT id, created_at, trigger, snapshot_json, input_json, health_change_id, classification")) {
        return { rows: snapshots.slice().sort(byNewest).slice(0, 2) };
      }
      if (sql.startsWith("SELECT id, barrier_id, from_health FROM app.health_change")) {
        const [orgId, barrierIds, createdAt, changeId] = values;
        if (orgId !== user.orgId || !Array.isArray(barrierIds)) return { rows: [] };
        const cursorTime = new Date(String(createdAt)).getTime();
        return { rows: healthChanges.filter((change) => barrierIds.includes(change.barrierId)
          && (new Date(change.createdAt).getTime() > cursorTime
            || (new Date(change.createdAt).getTime() === cursorTime && change.id > String(changeId))))
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
          .map((change) => ({ id: change.id, barrier_id: change.barrierId, from_health: change.fromHealth })) };
      }
      if (sql.startsWith("SELECT id, created_at, trigger, snapshot_json, input_json, classification")) {
        return { rows: snapshots.slice().sort(byNewest).slice(0, 1) };
      }
      if (sql.startsWith("SELECT DISTINCT b.id AS bowtie_id")) return { rows: [{ bowtie_id: ids.bowtie }] };
      if (sql.startsWith("INSERT INTO app.risk_snapshot")) {
        const row = {
          id: `30000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
          created_at: new Date(Date.UTC(2026, 9, 13, 0, 0, nextId)), trigger: values[4],
          snapshot_json: sortJson(JSON.parse(String(values[8]))), input_json: sortJson(JSON.parse(String(values[9]))),
          classification: values[6], health_change_id: values[10], bowtie_id: values[1],
        };
        snapshots.push(row);
        return { rows: [row] };
      }
      if (sql.startsWith("SELECT reason, actor FROM app.health_change")) {
        const change = healthChanges.find((item) => item.id === values[1]);
        return { rows: change ? [{ reason: change.reason, actor: "synthetic-reviewer" }] : [] };
      }
      if (sql.includes("FROM app.health_change")) return { rows: [] };
      throw new Error(`Unexpected SQL in RiskService test: ${sql}`);
    },
  } as unknown as Pool;
  return { service: new PostgresRiskService(pool), snapshots, set health(value: string) { health = value; } };
}

function byNewest(left: Record<string, unknown>, right: Record<string, unknown>): number {
  return new Date(String(right.created_at)).getTime() - new Date(String(left.created_at)).getTime();
}

describe("PostgresRiskService", () => {
  it("fails closed when the Organisation has no approved Risk Matrix", async () => {
    const { service } = fixture(false);
    await expect(service.getRisk(user, ids.bowtie)).rejects.toMatchObject({ status: 409, code: "risk_matrix_unconfigured" });
  });

  it("persists only changed snapshots and explains the Barrier Health impact", async () => {
    const testFixture = fixture();
    const first = await testFixture.service.getRisk(user, ids.bowtie);
    const same = await testFixture.service.getRisk(user, ids.bowtie);
    expect(same.id).toBe(first.id);
    expect(testFixture.snapshots).toHaveLength(1);

    testFixture.health = "degraded";
    const explanation = await testFixture.service.explain(user, ids.bowtie);
    expect(testFixture.snapshots).toHaveLength(2);
    expect(explanation).toMatchObject({ hasPrevious: true, changes: [{ beforeHealth: "healthy", afterHealth: "degraded" }] });
    expect(explanation.changes[0]?.impact).toBeGreaterThan(0);
  });

  it("refuses a stored snapshot above the caller's clearance", async () => {
    const testFixture = fixture();
    const saved = await testFixture.service.getRisk(user, ids.bowtie);
    const row = testFixture.snapshots.find((snapshot) => snapshot.id === saved.id);
    if (!row) throw new Error("Snapshot fixture did not persist");
    row.classification = "HIGHLY_RESTRICTED";
    await expect(testFixture.service.getRisk(user, ids.bowtie)).rejects.toBeInstanceOf(RiskServiceError);
  });

  it("persists an idempotent snapshot for each affected Health change", async () => {
    const change = {
      id: "40000000-0000-4000-8000-000000000001", barrierId: ids.preventiveBarrier,
      createdAt: "2026-10-13T00:00:01.000Z", fromHealth: "healthy", toHealth: "degraded", reason: "Synthetic review",
    };
    const testFixture = fixture(true, [change]);
    testFixture.health = "degraded";

    expect(await testFixture.service.processHealthChanges()).toBe(1);
    expect(testFixture.snapshots).toHaveLength(1);
    expect(testFixture.snapshots[0]).toMatchObject({ trigger: "health_change", health_change_id: change.id });
    expect(await testFixture.service.processHealthChanges()).toBe(0);
    expect(testFixture.snapshots).toHaveLength(1);
  });

  it("replays multiple queued Health changes against their event-time Barrier states", async () => {
    const changes: FakeHealthChange[] = [
      { id: "40000000-0000-4000-8000-000000000001", barrierId: ids.preventiveBarrier, createdAt: "2026-10-13T00:00:01.000Z", fromHealth: "healthy", toHealth: "degraded", reason: "First review" },
      { id: "40000000-0000-4000-8000-000000000002", barrierId: ids.preventiveBarrier, createdAt: "2026-10-13T00:00:02.000Z", fromHealth: "degraded", toHealth: "failed", reason: "Second review" },
    ];
    const testFixture = fixture(true, changes);
    testFixture.health = "failed";

    expect(await testFixture.service.processHealthChanges()).toBe(2);
    const firstSnapshot = testFixture.snapshots.find((snapshot) => snapshot.health_change_id === changes[0]?.id);
    const secondSnapshot = testFixture.snapshots.find((snapshot) => snapshot.health_change_id === changes[1]?.id);
    const healthFrom = (snapshot: Record<string, unknown> | undefined) => {
      const stored = snapshot?.input_json as { input: { barriers: { id: string; health: string }[] } } | undefined;
      return stored?.input.barriers.find((barrier) => barrier.id === ids.preventiveBarrier)?.health;
    };
    expect(healthFrom(firstSnapshot)).toBe("degraded");
    expect(healthFrom(secondSnapshot)).toBe("failed");

    const explanation = await testFixture.service.explain(user, ids.bowtie);
    expect(explanation.changes).toMatchObject([{ beforeHealth: "degraded", afterHealth: "failed", reason: "Second review" }]);
  });
});
