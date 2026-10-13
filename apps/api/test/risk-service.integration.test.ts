import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { RiskMatrix } from "@fieldloop/contracts";
import type { CurrentUser } from "../src/auth/service.js";
import { PostgresRiskService } from "../src/risk/service.js";
import { createRiskDatabase } from "../src/risk/database.js";

const databaseUrl = process.env["FIELDLOOP_RISK_TEST_DATABASE_URL"];
const integration = describe.skipIf(!databaseUrl);
type Classification = "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "HIGHLY_RESTRICTED";
let pool: Pool;
let service: PostgresRiskService;

interface FixtureOptions {
  approved?: boolean;
  classification?: Classification;
  barrierClassification?: Classification;
  simulated?: boolean;
}

interface RiskFixture {
  orgId: string;
  bowtieId: string;
  threatId: string;
  consequenceId: string;
  barrierId: string;
  mitigativeBarrierId: string;
  classification: Classification;
  simulated: boolean;
}

integration("PostgresRiskService against migrated PostgreSQL", () => {
  beforeAll(() => {
    if (!databaseUrl) throw new Error("FIELDLOOP_RISK_TEST_DATABASE_URL is required for PostgreSQL RiskService integration tests");
    pool = new Pool({ connectionString: databaseUrl, max: 5 });
    service = new PostgresRiskService(createRiskDatabase(pool));
  });

  afterAll(async () => { await pool?.end(); });

  it("persists snapshots, replays queued Health changes, and explains the latest change", async () => {
    const fixture = await createFixture();
    const user = reviewer(fixture.orgId, fixture.classification);
    const initial = await service.getRisk(user, fixture.bowtieId);
    expect(initial.calibration).toMatchObject({ standardRef: "SYNTHETIC-ORG-RISK-STD", standardVersion: "2026.1", approvedBy: "synthetic-technical-authority" });
    expect((await service.getRisk(user, fixture.bowtieId)).id).toBe(initial.id);

    const firstChange = randomUUID();
    const secondChange = randomUUID();
    const firstAt = new Date(Date.now() - 5_000);
    const secondAt = new Date(Date.now() - 4_000);
    await pool.query("UPDATE app.barrier SET health = 'failed' WHERE org_id = $1 AND id = $2", [fixture.orgId, fixture.barrierId]);
    await pool.query(
      `INSERT INTO app.health_change (id, org_id, barrier_id, from_health, to_health, reason, actor, classification, created_by, created_at, simulated)
              VALUES ($3, $1, $2, 'healthy', 'degraded', 'First synthetic review', 'synthetic-reviewer', $4, 'synthetic-reviewer', $5, false),
              ($6, $1, $2, 'degraded', 'failed', 'Second synthetic review', 'synthetic-reviewer', $4, 'synthetic-reviewer', $7, false)`,
      [fixture.orgId, fixture.barrierId, firstChange, fixture.classification, firstAt, secondChange, secondAt],
    );

    expect(await service.processHealthChanges()).toBe(2);
    const snapshots = await pool.query<{ health_change_id: string; barrier_health: string }>(
      `SELECT rs.health_change_id,
              (SELECT barrier->>'health' FROM jsonb_array_elements(rs.input_json->'input'->'barriers') barrier
               WHERE barrier->>'id' = $3) AS barrier_health
       FROM app.risk_snapshot rs WHERE rs.org_id = $1 AND rs.bowtie_id = $2 AND rs.health_change_id IS NOT NULL`,
      [fixture.orgId, fixture.bowtieId, fixture.barrierId],
    );
    expect(snapshots.rows).toEqual(expect.arrayContaining([
      { health_change_id: firstChange, barrier_health: "degraded" },
      { health_change_id: secondChange, barrier_health: "failed" },
    ]));
    expect(await service.processHealthChanges()).toBe(0);

    const explanation = await service.explain(user, fixture.bowtieId);
    expect(explanation).toMatchObject({
      hasPrevious: true,
      changes: [{ beforeHealth: "degraded", afterHealth: "failed", reason: "Second synthetic review" }],
    });
    expect(explanation.changes[0]?.impact).toBeGreaterThan(0);
    const events = await service.riskEventsAfter(user, { createdAt: new Date(0).toISOString(), id: "00000000-0000-0000-0000-000000000000" });
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.every((event) => event.bowtieId === fixture.bowtieId)).toBe(true);
    expect(events.every((event) => event.calibration.standardVersion === "2026.1")).toBe(true);
  }, 20_000);

  it("enforces Organisation scope and classification against stored rows", async () => {
    const tenant = await createFixture();
    const otherTenant = await createFixture();
    const user = reviewer(tenant.orgId, tenant.classification);

    expect((await service.listBowties(user)).map((bowtie) => bowtie.id)).toEqual([tenant.bowtieId]);
    await expect(service.getBowtie(user, otherTenant.bowtieId)).rejects.toMatchObject({ status: 404, code: "not_found" });

    const restricted = await createFixture({ classification: "INTERNAL", barrierClassification: "HIGHLY_RESTRICTED" });
    const restrictedRows = await pool.query<{ classification: string }>(
      "SELECT classification FROM app.barrier WHERE org_id = $1", [restricted.orgId],
    );
    expect(restrictedRows.rows).toEqual([{ classification: "HIGHLY_RESTRICTED" }, { classification: "HIGHLY_RESTRICTED" }]);
    await expect(service.getRisk(reviewer(restricted.orgId, "INTERNAL"), restricted.bowtieId))
      .rejects.toMatchObject({ status: 403, code: "clearance_denied" });
  });

  it("fails closed when an Organisation has no approved calibration", async () => {
    const fixture = await createFixture({ approved: false });
    await expect(service.getRisk(reviewer(fixture.orgId, fixture.classification), fixture.bowtieId))
      .rejects.toMatchObject({ status: 409, code: "risk_matrix_unconfigured" });
  });

  it("rejects an approved calibration without its controlled standard reference and version", async () => {
    const fixture = await createFixture({ approved: false });
    await expect(pool.query(
      `UPDATE app.organisation SET risk_matrix = $2::jsonb, risk_severity_criteria = $3::jsonb,
         risk_matrix_approved_at = now(), risk_matrix_approved_by = 'synthetic-technical-authority'
       WHERE org_id = $1`,
      [fixture.orgId, JSON.stringify(matrix()), JSON.stringify(severityCriteria())],
    )).rejects.toMatchObject({ constraint: "organisation_risk_matrix_provenance" });
  });

  it("does not resurrect simulated risk snapshots or Health changes after reset", async () => {
    const fixture = await createFixture({ simulated: true });
    const user = reviewer(fixture.orgId, fixture.classification);
    const baseline = await service.getRisk(user, fixture.bowtieId);
    await pool.query("SELECT app.capture_simulation_baseline($1)", [fixture.orgId]);

    const scenarioId = randomUUID();
    const runId = randomUUID();
    await pool.query(
      `INSERT INTO app.scenario (id, org_id, file, simulated, classification, created_by)
       VALUES ($1, $2, 'synthetic-risk-reset.json', true, $3, 'synthetic-reviewer')`,
      [scenarioId, fixture.orgId, fixture.classification],
    );
    await pool.query(
      `INSERT INTO app.simulation_run (id, org_id, scenario_id, state, simulated, classification, created_by)
       VALUES ($1, $2, $3, 'ready', true, $4, 'synthetic-reviewer')`,
      [runId, fixture.orgId, scenarioId, fixture.classification],
    );
    await pool.query("UPDATE app.simulation_workspace SET active_run_id = $2 WHERE org_id = $1", [fixture.orgId, runId]);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.simulation_run_id', $1, true)", [runId]);
      await client.query("UPDATE app.barrier SET health = 'degraded' WHERE org_id = $1 AND id = $2", [fixture.orgId, fixture.barrierId]);
      await client.query(
        `INSERT INTO app.health_change (org_id, barrier_id, from_health, to_health, reason, actor, simulated, classification, created_by, simulation_run_id)
         VALUES ($1, $2, 'healthy', 'degraded', 'Synthetic simulation change', 'synthetic-reviewer', true, $3, 'synthetic-reviewer', $4)`,
        [fixture.orgId, fixture.barrierId, fixture.classification, runId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    expect(await service.processHealthChanges()).toBe(1);
    await pool.query("SELECT app.restore_simulation_baseline($1)", [fixture.orgId]);

    const current = await pool.query<{ health: string; count: string }>(
      `SELECT b.health, (SELECT count(*) FROM app.current_risk_snapshot WHERE org_id = $1)::text AS count
       FROM app.barrier b WHERE b.org_id = $1 AND b.id = $2`, [fixture.orgId, fixture.barrierId],
    );
    expect(current.rows[0]).toEqual({ health: "healthy", count: "1" });
    expect((await service.getRisk(user, fixture.bowtieId)).id).toBe(baseline.id);
    expect(await service.processHealthChanges()).toBe(0);
    const events = await service.riskEventsAfter(user, { createdAt: new Date(0).toISOString(), id: "00000000-0000-0000-0000-000000000000" });
    expect(events.every((event) => event.snapshotId === baseline.id)).toBe(true);
  }, 20_000);
});

async function createFixture(options: FixtureOptions = {}): Promise<RiskFixture> {
  const fixture = {
    orgId: `risk-integration-${randomUUID()}`,
    bowtieId: randomUUID(),
    threatId: randomUUID(),
    consequenceId: randomUUID(),
    barrierId: randomUUID(),
    mitigativeBarrierId: randomUUID(),
    classification: options.classification ?? "PUBLIC",
    barrierClassification: options.barrierClassification ?? options.classification ?? "PUBLIC",
    simulated: options.simulated ?? false,
  } as const;
  const approved = options.approved ?? true;
  await pool.query(
    `INSERT INTO app.organisation
       (org_id, name, simulated, classification, risk_matrix, risk_severity_criteria, risk_matrix_approved_at, risk_matrix_approved_by,
        risk_matrix_standard_ref, risk_matrix_standard_version)
     VALUES ($1, 'Synthetic Risk Integration Organisation', $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9)`,
    [fixture.orgId, fixture.simulated, fixture.classification,
      approved ? JSON.stringify(matrix()) : null,
      approved ? JSON.stringify(severityCriteria()) : null,
      approved ? new Date() : null,
      approved ? "synthetic-technical-authority" : null,
      approved ? "SYNTHETIC-ORG-RISK-STD" : null,
      approved ? "2026.1" : null],
  );
  await pool.query(
    `INSERT INTO app.bowtie (id, org_id, hazard, top_event, domain, status, simulated, classification, created_by)
     VALUES ($1, $2, 'Synthetic hazard', 'Synthetic top event', 'integration-test', 'active', $3, $4, 'synthetic-reviewer')`,
    [fixture.bowtieId, fixture.orgId, fixture.simulated, fixture.classification],
  );
  await pool.query(
    `INSERT INTO app.threat (id, org_id, bowtie_id, name, frequency_per_year, simulated, classification, created_by)
     VALUES ($1, $2, $3, 'Synthetic threat', 0.1, $4, $5, 'synthetic-reviewer')`,
    [fixture.threatId, fixture.orgId, fixture.bowtieId, fixture.simulated, fixture.classification],
  );
  await pool.query(
    `INSERT INTO app.consequence (id, org_id, bowtie_id, name, severity, p_conditional, simulated, classification, created_by)
     VALUES ($1, $2, $3, 'Synthetic consequence', $4::jsonb, 0.9, $5, $6, 'synthetic-reviewer')`,
    [fixture.consequenceId, fixture.orgId, fixture.bowtieId,
      JSON.stringify({ people: 3, environment: 2, financial: 2, serviceContinuity: 3, reputation: 2, legalRegulatory: 1 }),
      fixture.simulated, fixture.classification],
  );
  await pool.query(
    `INSERT INTO app.barrier (id, org_id, name, type, side, pfd_band, health, simulated, classification, created_by)
     VALUES ($1, $2, 'Synthetic barrier', 'technical', 'preventive', 0.01, 'healthy', $3, $4, 'synthetic-reviewer')`,
    [fixture.barrierId, fixture.orgId, fixture.simulated, fixture.barrierClassification],
  );
  await pool.query(
    `INSERT INTO app.barrier (id, org_id, name, type, side, pfd_band, health, simulated, classification, created_by)
     VALUES ($1, $2, 'Synthetic mitigative barrier', 'human', 'mitigative', 0.1, 'healthy', $3, $4, 'synthetic-reviewer')`,
    [fixture.mitigativeBarrierId, fixture.orgId, fixture.simulated, fixture.barrierClassification],
  );
  await pool.query(
    `INSERT INTO app.barrier_path (org_id, barrier_id, threat_id, position, simulated, classification, created_by)
     VALUES ($1, $2, $3, 1, $4, $5, 'synthetic-reviewer')`,
    [fixture.orgId, fixture.barrierId, fixture.threatId, fixture.simulated, fixture.classification],
  );
  await pool.query(
    `INSERT INTO app.barrier_path (org_id, barrier_id, consequence_id, position, simulated, classification, created_by)
     VALUES ($1, $2, $3, 1, $4, $5, 'synthetic-reviewer')`,
    [fixture.orgId, fixture.mitigativeBarrierId, fixture.consequenceId, fixture.simulated, fixture.classification],
  );
  return fixture;
}

function reviewer(orgId: string, clearance: CurrentUser["clearance"]): CurrentUser {
  return {
    sub: "synthetic-reviewer", roles: ["fieldloop.viewer"], persona: "Risk reviewer", orgId, clearance,
    csrfToken: "synthetic-csrf", authTime: new Date(),
  };
}

function matrix(): RiskMatrix {
  return {
    frequencyThresholds: [0.0001, 0.001, 0.01, 0.1],
    cells: Array.from({ length: 5 }, (_, row) => Array.from({ length: 5 }, (_, column) => {
      const rank = row * 5 + column + 1;
      return { rank, zone: rank < 9 ? "green" : rank < 18 ? "amber" : "red" };
    })),
  };
}

function severityCriteria() {
  return {
    people: ["P1", "P2", "P3", "P4", "P5"],
    environment: ["E1", "E2", "E3", "E4", "E5"],
    financial: ["F1", "F2", "F3", "F4", "F5"],
    serviceContinuity: ["S1", "S2", "S3", "S4", "S5"],
    reputation: ["R1", "R2", "R3", "R4", "R5"],
    legalRegulatory: ["L1", "L2", "L3", "L4", "L5"],
  };
}
