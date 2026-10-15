import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { registerDomainPackRecords } from "../apps/api/dist/domain-packs.js";

/** Reproduce startup registration against a persisted run in the disposable database. */
export async function testCatalogColdStart(database, application, packs) {
  const orgId = "catalog-cold-start-test";
  await registerDomainPackRecords(application, orgId, packs);
  const scenarioId = randomUUID();
  const runId = randomUUID();
  await sql`INSERT INTO app.scenario (id, org_id, file, version, simulated, classification)
    VALUES (${scenarioId}::uuid, ${orgId}, 'synthetic.yaml', '1.0.0', true, 'CONFIDENTIAL')`.execute(database);
  await sql`SELECT app.capture_simulation_baseline(${orgId})`.execute(database);
  await sql`INSERT INTO app.simulation_run (id, org_id, scenario_id, state, simulated, classification)
    VALUES (${runId}::uuid, ${orgId}, ${scenarioId}::uuid, 'ready', true, 'CONFIDENTIAL')`.execute(database);
  await sql`UPDATE app.simulation_workspace SET active_run_id = ${runId}::uuid WHERE org_id = ${orgId}`.execute(database);
  const snapshot = async () => {
    const rows = [];
    for (const table of ["threat_category", "bowtie", "independence_group", "threat", "consequence", "barrier",
      "barrier_path", "degradation_factor", "degradation_control", "ai_system", "guardrail_policy",
      "simulation_workspace", "simulation_run"]) {
      rows.push(...(await sql`SELECT ${table}::text AS kind, to_jsonb(t) AS value
        FROM ${sql.table(`app.${table}`)} t WHERE org_id = ${orgId} ORDER BY id`.execute(database)).rows);
    }
    return rows;
  };
  const before = await snapshot();
  await registerDomainPackRecords(application, orgId, packs);
  await registerDomainPackRecords(application, orgId, packs);
  assert.deepEqual(await snapshot(), before, "cold-start reload must preserve baseline, run and safety records");
  const changed = structuredClone(packs);
  changed.find(p => p.aiSafety).aiSafety.bowtie.barriers[0].performanceStandard = "Changed during run";
  await assert.rejects(registerDomainPackRecords(application, orgId, changed), /simulation|reviewed Bowtie/);
  assert.deepEqual(await snapshot(), before, "changed seed must fail closed without partial registration");
  await assert.rejects(sql`UPDATE app.barrier SET health = 'healthy' WHERE org_id = ${orgId}`.execute(application), /SimulationRun/);
  assert.deepEqual(await snapshot(), before, "baseline guard remains enforced");
  console.log("Catalog cold-start regression passed: persisted ready run, identical reload, changed seed rejected and baseline guard intact.");
}
