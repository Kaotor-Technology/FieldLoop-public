import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { deterministicUuid, driverConnectionString, requireClassification, validateBowtieSeed } from "../common.mjs";
import { buildDataset } from "../../../data/synthetic/bangkok/generate.mjs";
import { pointInArea } from "../../../data/synthetic/bangkok/extract.mjs";

export const CREATED_BY = "seed:bangkok";
const DATA_ROOT = new URL("../../../data/synthetic/bangkok/", import.meta.url);
const TABLES = ["asset", "bowtie", "threat", "consequence", "independence_group", "barrier",
  "barrier_path", "degradation_factor", "degradation_control", "evidence", "geo_reference"];
const jsonb = (value) => sql`${JSON.stringify(value)}::jsonb`;
const geometry = (value) => sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(value)}::text), 4326)`;
export const databaseId = (orgId, key) => deterministicUuid(`fieldloop:bangkok:${orgId}:${key}`);
export const readBowtieSeed = () => JSON.parse(readFileSync(new URL("bowtie-d.json", DATA_ROOT), "utf8"));

export function validateDataset(dataset, bowtie) {
  validateBowtieSeed(bowtie, "Bowtie D");
  const features = [...dataset.zones.features, ...dataset.canals.features, ...dataset.facilities.features];
  const ids = new Set();
  for (const feature of features) {
    if (!feature.id || ids.has(feature.id)) throw new Error("Asset IDs must be present and unique.");
    ids.add(feature.id);
    requireClassification(feature.properties.classification, `Feature ${feature.id}`);
    if (dataset.canals.features.includes(feature)) {
      if (feature.geometry.type !== "LineString" || feature.properties.simulated !== false
          || feature.properties.label !== "PUBLIC BASE MAP" || feature.properties.licence !== "ODbL-1.0") {
        throw new Error(`Canal ${feature.id} requires public OSM provenance.`);
      }
    } else if (feature.properties.simulated !== true || !["SIMULATION", "SYNTHETIC"].includes(feature.properties.label)) {
      throw new Error(`Asset ${feature.id} must be labelled simulated.`);
    }
  }
  for (const facility of dataset.facilities.features) {
    const zone = dataset.zones.features.find(({ id }) => id === facility.properties.zone_code);
    if (!zone || facility.geometry.type !== "Point" || !pointInArea(facility.geometry.coordinates, zone.geometry)) {
      throw new Error(`Facility ${facility.id} is outside its demo zone.`);
    }
  }
  if (!Array.isArray(bowtie.assetCodes) || !bowtie.assetCodes.includes(bowtie.assetCode)
      || new Set(bowtie.assetCodes).size !== bowtie.assetCodes.length
      || bowtie.assetCodes.some((code) => !dataset.zones.features.some(({ id }) => id === code))) {
    throw new Error("Bowtie D scope must reference its demo zones.");
  }
  const nestedIds = new Set();
  for (const barrier of bowtie.barriers) {
    if (!ids.has(barrier.assetCode)) throw new Error(`Barrier ${barrier.id} has an unknown Asset.`);
    for (const entity of [...barrier.evidence, ...(barrier.degradationFactors ?? []).flatMap((factor) => [factor, ...factor.controls])]) {
      if (nestedIds.has(entity.id)) throw new Error(`Duplicate nested seed ID: ${entity.id}`);
      nestedIds.add(entity.id);
    }
  }
  return features;
}

export function buildSeedQueries(database, dataset, orgId, bowtie = readBowtieSeed()) {
  if (typeof orgId !== "string" || !orgId.trim()) throw new Error("An Organisation ID is required.");
  const features = validateDataset(dataset, bowtie);
  const loadedIds = new Map(TABLES.map((table) => [table, []]));
  const queries = [];
  const metadata = { org_id: orgId, simulated: true, classification: bowtie.metadata.classification, created_by: CREATED_BY };
  const id = (type, key) => databaseId(orgId, `${type}:${key}`);
  const upsert = (table, values) => database.insertInto(`app.${table}`).values(values)
    .onConflict((conflict) => conflict.column("id").doUpdateSet((expression) => Object.fromEntries(
      Object.keys(values).filter((key) => key !== "id").map((key) => [key, expression.ref(`excluded.${key}`)]))));
  const add = (table, key, values) => {
    const rowId = id(table, key);
    loadedIds.get(table).push(rowId);
    queries.push(upsert(table, { id: rowId, ...metadata, ...values }));
  };

  queries.push(upsert("organisation", {
    id: deterministicUuid(`fieldloop:organisation:${orgId}`), org_id: orgId,
    name: "FieldLoop Demo Organisation (SYNTHETIC)", simulated: true, classification: "INTERNAL",
    // Same shared row as DL-01; a seed never deletes the Organisation.
    created_by: "seed:dl-01",
  }));
  for (const feature of features) {
    const isCanal = dataset.canals.features.includes(feature);
    const attributes = isCanal
      ? { ...feature.properties, asset_code: feature.id, label: "SIMULATION", simulated: true,
          classification: "HIGHLY_RESTRICTED", geometry_basis: "Public OSM canal geometry; all operational data is simulated." }
      : feature.properties;
    add("asset", feature.id, {
      type: dataset.zones.features.includes(feature) ? "area" : isCanal ? "linear" : "facility",
      parent_id: feature.properties.zone_code ? id("asset", feature.properties.zone_code) : null,
      domain_pack: "flood-water", geom: geometry(feature.geometry), attributes: jsonb(attributes),
      classification: isCanal ? "HIGHLY_RESTRICTED" : feature.properties.classification,
    });
  }
  add("bowtie", bowtie.id, { hazard: bowtie.hazard, top_event: bowtie.topEvent,
    domain: bowtie.domain, status: bowtie.status, version: bowtie.version });
  const bowtieId = id("bowtie", bowtie.id);
  for (const code of bowtie.assetCodes) {
    queries.push(database.insertInto("app.bowtie_asset").values({
      ...metadata, bowtie_id: bowtieId, asset_id: id("asset", code),
    }).onConflict((conflict) => conflict.columns(["bowtie_id", "asset_id"]).doUpdateSet(metadata)));
  }
  for (const threat of bowtie.threats) add("threat", threat.id, {
    bowtie_id: bowtieId, name: threat.name, frequency_per_year: threat.frequencyPerYear,
  });
  for (const consequence of bowtie.consequences) add("consequence", consequence.id, {
    bowtie_id: bowtieId, name: consequence.name, severity: jsonb(consequence.severity), p_conditional: consequence.conditionalProbability,
  });
  for (const group of bowtie.independenceGroups) add("independence_group", group.id, { bowtie_id: bowtieId, cause: group.cause });
  for (const barrier of bowtie.barriers) add("barrier", barrier.id, {
    name: barrier.name, type: barrier.type, side: barrier.side, pfd_band: barrier.pfdBand, health: barrier.health,
    evidence_interval: barrier.evidenceInterval, performance_standard: barrier.performanceStandard, triad: jsonb(barrier.triad),
    independence_group_id: barrier.independenceGroupId ? id("independence_group", barrier.independenceGroupId) : null,
  });
  for (const path of bowtie.paths) {
    for (const [index, barrierId] of path.barrierIds.entries()) add("barrier_path", `${path.id}:${barrierId}`, {
      barrier_id: id("barrier", barrierId), position: index + 1,
      threat_id: path.side === "preventive" ? id("threat", path.targetId) : null,
      consequence_id: path.side === "mitigative" ? id("consequence", path.targetId) : null,
    });
  }
  for (const barrier of bowtie.barriers) {
    for (const factor of barrier.degradationFactors ?? []) {
      add("degradation_factor", factor.id, { barrier_id: id("barrier", barrier.id), description: factor.description });
      for (const control of factor.controls) add("degradation_control", control.id, {
        degradation_factor_id: id("degradation_factor", factor.id), description: control.description,
      });
    }
    const asset = features.find(({ id: assetId }) => assetId === barrier.assetCode);
    for (const evidence of barrier.evidence) {
      add("evidence", evidence.id, { barrier_id: id("barrier", barrier.id), kind: evidence.kind,
        source: evidence.source, observed_at: evidence.observedAt, blob_uri: evidence.blobUri ?? null });
      add("geo_reference", evidence.id, {
        evidence_id: id("evidence", evidence.id), target_type: "asset", target_id: id("asset", asset.id),
        kind: "asset", geom: geometry(asset.geometry), status: "confirmed", confidence: 1,
        classification: asset.properties.classification,
      });
    }
  }

  const stale = (table) => database.deleteFrom(`app.${table}`).where("org_id", "=", orgId).where("created_by", "=", CREATED_BY);
  queries.push(stale("bowtie_asset").where((expression) => expression.or([
    expression("bowtie_id", "!=", bowtieId), expression("asset_id", "not in", bowtie.assetCodes.map((code) => id("asset", code))),
  ])));
  // Children before parents. Area parents precede Facilities in insertion, so remove stale
  // Facilities first. Foreign references make deletion fail and roll back the entire load.
  for (const table of [...TABLES].reverse()) {
    const ids = loadedIds.get(table);
    const query = ids.length ? stale(table).where("id", "not in", ids) : stale(table);
    if (table === "asset") queries.push(query.where("type", "=", "facility"));
    queries.push(query);
  }
  return queries;
}

export async function loadSeed(database, dataset, orgId, bowtie = readBowtieSeed()) {
  const preview = buildSeedQueries(database, dataset, orgId, bowtie); // Validate before DB access.
  return database.transaction().execute(async (transaction) => {
    // Serialize reruns for this seed/Organisation, including stale-row cleanup.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bangkok:${orgId}`}, 0))`.execute(transaction);
    for (const query of buildSeedQueries(transaction, dataset, orgId, bowtie)) await query.execute();
    const counts = {};
    for (const table of TABLES) {
      const { count } = await transaction.selectFrom(`app.${table}`).select((e) => e.fn.countAll().as("count"))
        .where("org_id", "=", orgId).where("created_by", "=", CREATED_BY).executeTakeFirstOrThrow();
      const expected = preview.filter((query) => query.compile().sql.startsWith(`insert into "app"."${table}"`)).length;
      if (Number(count) !== expected) throw new Error(`Read-back failed for ${table}: expected ${expected}, got ${count}.`);
      counts[table] = Number(count);
    }
    const { rows: [invalid] } = await sql`
      SELECT count(*)::int AS count FROM app.asset
      WHERE org_id = ${orgId} AND created_by = ${CREATED_BY}
        AND (geom IS NULL OR ST_IsEmpty(geom) OR NOT ST_IsValid(geom) OR ST_SRID(geom) <> 4326)
    `.execute(transaction);
    if (invalid.count !== 0) throw new Error("Read-back found invalid Asset geometry.");
    return counts;
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--print-sql")) throw new Error("Usage: seed.mjs [--print-sql]");
  const orgId = process.env.FIELDLOOP_ORG_ID;
  if (!orgId?.trim()) throw new Error("Set FIELDLOOP_ORG_ID.");
  const printSql = args.includes("--print-sql");
  const databaseUrl = process.env.FIELDLOOP_DATABASE_URL;
  if (!printSql && !databaseUrl) throw new Error("Set FIELDLOOP_DATABASE_URL to the target database before loading the seed.");
  const database = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({
    connectionString: printSql ? undefined : driverConnectionString(databaseUrl), max: 1, connectionTimeoutMillis: 10_000,
  }) }) });
  try {
    const dataset = buildDataset();
    if (printSql) console.log(JSON.stringify(buildSeedQueries(database, dataset, orgId).map((query) => {
      const { sql: querySql, parameters } = query.compile();
      return { sql: querySql, parameters };
    }), null, 2));
    else console.log("Loaded Bangkok SIMULATION / SYNTHETIC data: " + JSON.stringify(await loadSeed(database, dataset, orgId)));
  } finally { await database.destroy(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
