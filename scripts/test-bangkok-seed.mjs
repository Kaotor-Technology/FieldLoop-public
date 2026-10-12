import assert from "node:assert/strict";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { buildDataset } from "../data/synthetic/bangkok/generate.mjs";
import { databaseId, loadSeed, readBowtieSeed } from "../db/seed/bangkok/seed.mjs";
import { buildDataset as buildPipeline } from "../data/synthetic/dl-01/generate.mjs";
import { loadSeed as loadPipeline } from "../db/seed/dl-01/seed.mjs";

const orgId = "seed-test-org";
const dataset = buildDataset();
const database = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({
  connectionString: process.env.FIELDLOOP_DATABASE_URL, max: 1,
}) }) });
const expected = { asset: 178, bowtie: 1, threat: 4, consequence: 4, independence_group: 1,
  barrier: 15, barrier_path: 23, degradation_factor: 4, degradation_control: 4, evidence: 30, geo_reference: 30 };
async function state(creator) {
  const result = {};
  for (const table of Object.keys(expected)) {
    let query = database.selectFrom(`app.${table}`).selectAll().where("org_id", "=", orgId).orderBy("id");
    if (creator) query = query.where("created_by", "=", creator);
    result[table] = await query.execute();
  }
  result.organisation = await database.selectFrom("app.organisation").selectAll().where("org_id", "=", orgId).execute();
  result.bowtie_asset = await database.selectFrom("app.bowtie_asset").selectAll().where("org_id", "=", orgId).orderBy("asset_id").execute();
  return JSON.stringify(result);
}
try {
  await sql`CREATE FUNCTION app.reject_bangkok_test() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'bangkok test: evidence rejected'; END $$`.execute(database);
  await sql`CREATE TRIGGER reject_bangkok_test BEFORE INSERT ON app.evidence
    FOR EACH ROW EXECUTE FUNCTION app.reject_bangkok_test()`.execute(database);
  await assert.rejects(loadSeed(database, dataset, orgId), /bangkok test: evidence rejected/);
  for (const table of [...Object.keys(expected), "organisation", "bowtie_asset"]) {
    assert.equal((await database.selectFrom(`app.${table}`).selectAll().execute()).length, 0, `rollback: ${table}`);
  }
  await sql`DROP TRIGGER reject_bangkok_test ON app.evidence`.execute(database);
  await sql`DROP FUNCTION app.reject_bangkok_test()`.execute(database);
  assert.deepEqual(await loadSeed(database, dataset, orgId), expected);
  const first = await state();
  assert.deepEqual(await loadSeed(database, dataset, orgId), expected);
  assert.equal(await state(), first, "identical rows after rerun");

  const { rows: [spatial] } = await sql`
    SELECT count(*)::int AS count FROM app.asset f JOIN app.asset z ON z.id = f.parent_id
    WHERE f.org_id = ${orgId} AND f.created_by = 'seed:bangkok' AND f.type = 'facility'
      AND ST_Covers(z.geom, f.geom) AND ST_GeometryType(f.geom) = 'ST_Point'
  `.execute(database);
  assert.equal(spatial.count, 8, "Facility Points covered by their Area parents");
  const { rows: [labelling] } = await sql`
    SELECT count(*)::int AS count FROM app.asset
    WHERE org_id = ${orgId} AND created_by = 'seed:bangkok'
      AND simulated AND classification = 'HIGHLY_RESTRICTED'
      AND attributes->>'label' IN ('SIMULATION','SYNTHETIC')
  `.execute(database);
  assert.equal(labelling.count, 178);
  const { rows: [paths] } = await sql`
    SELECT count(*)::int AS count FROM app.barrier_path p JOIN app.barrier b ON b.id = p.barrier_id
    WHERE p.org_id = ${orgId} AND p.created_by = 'seed:bangkok'
      AND ((b.side = 'preventive' AND p.threat_id IS NOT NULL AND p.consequence_id IS NULL)
        OR (b.side = 'mitigative' AND p.consequence_id IS NOT NULL AND p.threat_id IS NULL))
  `.execute(database);
  assert.equal(paths.count, 23);
  const initialBowtie = readBowtieSeed();
  const healthRows = await database.selectFrom("app.barrier").select(["id", "health"])
    .where("org_id", "=", orgId).where("created_by", "=", "seed:bangkok").execute();
  assert.deepEqual(Object.fromEntries(healthRows.map(row => [row.id, row.health])),
    Object.fromEntries(initialBowtie.barriers.map(barrier => [databaseId(orgId, `barrier:${barrier.id}`), barrier.health])),
    "every initial Barrier Health must match the authored seed");
  const scope = await database.selectFrom("app.bowtie_asset").select("asset_id").where("org_id", "=", orgId).execute();
  assert.deepEqual(scope.map(row => row.asset_id).sort(), initialBowtie.assetCodes.map(code => databaseId(orgId, `asset:${code}`)).sort(),
    "Bowtie D must cover both demo Areas");
  for (const [table, count] of Object.entries(expected)) {
    const rows = await database.selectFrom(`app.${table}`).selectAll().where("org_id", "=", orgId).execute();
    assert.equal(rows.length, count);
    assert(rows.every(row => row.simulated === true && row.classification ===
      (["asset", "geo_reference"].includes(table) ? "HIGHLY_RESTRICTED" : "CONFIDENTIAL")));
  }

  // Evidence on a public-source canal must inherit the restricted database Asset class.
  const canal = dataset.canals.features[0];
  const canalBowtie = readBowtieSeed();
  canalBowtie.barriers[0].assetCode = canal.id;
  await loadSeed(database, dataset, orgId, canalBowtie);
  const { rows: canalReferences } = await sql`
    SELECT g.classification, a.classification AS asset_classification,
      g.simulated, ST_Equals(g.geom, a.geom) AS same_geometry
    FROM app.geo_reference g JOIN app.asset a ON a.id = g.target_id AND a.org_id = g.org_id
    WHERE g.org_id = ${orgId} AND g.created_by = 'seed:bangkok'
      AND a.id = ${databaseId(orgId, `asset:${canal.id}`)}
  `.execute(database);
  assert.equal(canalReferences.length, 2);
  assert(canalReferences.every(row => row.classification === "HIGHLY_RESTRICTED"
    && row.asset_classification === row.classification && row.simulated && row.same_geometry),
  "Geo References must not downgrade the classification of their operational Asset");
  assert.equal(canal.properties.classification, "PUBLIC", "source provenance stays public");
  await loadSeed(database, dataset, orgId);
  assert.equal(await state(), first, "restoring the Bowtie retains the original seed state");

  // A stale seed row is removed; a row somebody else added on a live Barrier stays.
  const evidenceValues = { org_id: orgId, barrier_id: databaseId(orgId, "barrier:pumping-stations"),
    kind: "performance_check", source: "manual", observed_at: "2026-10-12T00:00:00Z", simulated: true, classification: "CONFIDENTIAL" };
  const ownId = "00000000-0000-4000-8000-000000000001";
  const otherId = "00000000-0000-4000-8000-000000000002";
  await database.insertInto("app.evidence").values([
    { id: ownId, ...evidenceValues, created_by: "seed:bangkok" },
    { id: otherId, ...evidenceValues, created_by: "test:other" },
  ]).execute();
  await loadSeed(database, dataset, orgId);
  assert.deepEqual((await database.selectFrom("app.evidence").select("id").where("id", "in", [ownId, otherId]).execute()).map(r => r.id), [otherId]);

  const staleId = "00000000-0000-4000-8000-000000000003";
  await database.insertInto("app.barrier").values({ id: staleId, org_id: orgId, type: "technical", side: "preventive",
    simulated: true, classification: "CONFIDENTIAL", created_by: "seed:bangkok" }).execute();
  await database.updateTable("app.evidence").set({ barrier_id: staleId }).where("id", "=", otherId).execute();
  const blocked = await state();
  await assert.rejects(loadSeed(database, dataset, orgId), /violates foreign key constraint/);
  assert.equal(await state(), blocked, "foreign-reference failure rolls back every change");
  await database.deleteFrom("app.evidence").where("id", "=", otherId).execute();
  await database.deleteFrom("app.barrier").where("id", "=", staleId).execute();

  // Remove an unused Facility, then restore it, exercising parent-aware Asset cleanup.
  const reduced = structuredClone(dataset);
  reduced.facilities.features = reduced.facilities.features.filter(f => f.id !== "P-1");
  assert.equal((await loadSeed(database, reduced, orgId)).asset, 177);
  await loadSeed(database, dataset, orgId);
  const restored = JSON.parse(await state());
  const baseline = JSON.parse(first);
  const facilityId = databaseId(orgId, "asset:P-1");
  // A deleted-and-recreated Facility gets a new created_at; every other column/row is stable.
  const recreated = restored.asset.find(row => row.id === facilityId);
  const original = baseline.asset.find(row => row.id === facilityId);
  assert.notEqual(recreated.created_at, original.created_at);
  original.created_at = recreated.created_at;
  assert.deepEqual(restored, baseline, "only the recreated Facility timestamp changes");
  await loadPipeline(database, buildPipeline(), orgId);
  const combined = await state();
  await loadSeed(database, dataset, orgId);
  assert.equal(await state(), combined, "Bangkok rerun preserves DL-01 rows");
  await loadPipeline(database, buildPipeline(), orgId);
  assert.equal(await state(), combined, "DL-01 rerun preserves Bangkok rows and shared Organisation");
  const beforeOtherOrg = await state();
  await loadSeed(database, dataset, "seed-test-other-org");
  assert.equal(await state(), beforeOtherOrg, "another Organisation is isolated");
  const invalid = readBowtieSeed();
  delete invalid.metadata.classification;
  await assert.rejects(loadSeed(database, dataset, orgId, invalid), /metadata.classification/);
  assert.equal(await state(), beforeOtherOrg);
  console.log("Bangkok assertions passed: rollback, rerun, spatial geometry, labels, paths, cleanup, Organisation isolation and DL-01 coexistence.");
} finally { await database.destroy(); }
