import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { buildDataset, writeDataset } from "./generate.mjs";

const UUID_NAMESPACE_URL = Buffer.from(
  "6ba7b8119dad11d180b400c04fd430c8",
  "hex",
);
const DEFAULT_OUTPUT_DIR = new URL(".", import.meta.url);
const CREATED_BY = "seed:dl-01";
const CLASSIFICATION = "internal";

function geometryExpression(geometry) {
  return sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geometry)}::text), 4326)`;
}

function deterministicUuid(name) {
  const bytes = Buffer.from(
    createHash("sha1")
      .update(UUID_NAMESPACE_URL)
      .update(name, "utf8")
      .digest()
      .subarray(0, 16),
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function databaseId(orgId, entityKey) {
  return deterministicUuid("fieldloop:dl-01:" + orgId + ":" + entityKey);
}

function insertAsset(database, { id, orgId, type, parentId, domainPack, geometry, attributes }) {
  return database
    .insertInto("app.asset")
    .values({
      id,
      org_id: orgId,
      type,
      parent_id: parentId,
      domain_pack: domainPack,
      geom: geometryExpression(geometry),
      attributes: sql`${JSON.stringify(attributes)}::jsonb`,
      simulated: true,
      classification: CLASSIFICATION,
      created_by: CREATED_BY,
    })
    .onConflict((conflict) => conflict.column("id").doUpdateSet((expression) => ({
      org_id: expression.ref("excluded.org_id"),
      type: expression.ref("excluded.type"),
      parent_id: expression.ref("excluded.parent_id"),
      domain_pack: expression.ref("excluded.domain_pack"),
      geom: expression.ref("excluded.geom"),
      attributes: expression.ref("excluded.attributes"),
      simulated: expression.ref("excluded.simulated"),
      classification: expression.ref("excluded.classification"),
      created_by: expression.ref("excluded.created_by"),
    })));
}

function insertSegment(database, { id, orgId, assetId, geometry, properties }) {
  return database
    .insertInto("app.segment")
    .values({
      id,
      org_id: orgId,
      asset_id: assetId,
      chainage_from: properties.chainage_from_m,
      chainage_to: properties.chainage_to_m,
      geom: geometryExpression(geometry),
      simulated: true,
      classification: CLASSIFICATION,
      created_by: CREATED_BY,
    })
    .onConflict((conflict) => conflict.column("id").doUpdateSet((expression) => ({
      org_id: expression.ref("excluded.org_id"),
      asset_id: expression.ref("excluded.asset_id"),
      chainage_from: expression.ref("excluded.chainage_from"),
      chainage_to: expression.ref("excluded.chainage_to"),
      geom: expression.ref("excluded.geom"),
      simulated: expression.ref("excluded.simulated"),
      classification: expression.ref("excluded.classification"),
      created_by: expression.ref("excluded.created_by"),
    })));
}

export function buildSeedQueries(database, dataset, orgId) {
  if (typeof orgId !== "string" || orgId.trim().length === 0) {
    throw new Error("An Organisation ID is required.");
  }

  const routeFeature = dataset.route.features[0];
  const pipelineId = databaseId(orgId, "asset:dl-01");
  const statements = [
    insertAsset(database, {
      id: pipelineId,
      orgId,
      type: "linear",
      parentId: null,
      domainPack: "pipeline-integrity",
      geometry: routeFeature.geometry,
      attributes: {
        asset_code: routeFeature.properties.asset_code,
        name: routeFeature.properties.name,
        label: routeFeature.properties.label,
        nominal_diameter_in: routeFeature.properties.nominal_diameter_in,
        length_m: routeFeature.properties.length_m,
        start_region: routeFeature.properties.start_region,
        via_regions: routeFeature.properties.via_regions,
        end_region: routeFeature.properties.end_region,
      },
    }),
  ];

  for (const facility of dataset.facilities.features) {
    const facilityId = databaseId(orgId, "asset:" + facility.id);
    statements.push(
      insertAsset(database, {
        id: facilityId,
        orgId,
        type: "facility",
        parentId: pipelineId,
        domainPack: "pipeline-integrity",
        geometry: facility.geometry,
        attributes: {
          name: facility.properties.name,
          facility_type: facility.properties.facility_type,
          chainage_m: facility.properties.chainage_m,
          label: facility.properties.label,
        },
      }),
    );
  }

  for (const segment of dataset.segments.features) {
    statements.push(
      insertSegment(database, {
        id: databaseId(orgId, "segment:" + segment.id),
        orgId,
        assetId: pipelineId,
        geometry: segment.geometry,
        properties: segment.properties,
      }),
    );
  }

  return statements;
}

export async function loadSeed(database, dataset, orgId) {
  await database.transaction().execute(async (transaction) => {
    for (const query of buildSeedQueries(transaction, dataset, orgId)) {
      await query.execute();
    }
  });
}

function validateConnectionString(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("FIELDLOOP_DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("FIELDLOOP_DATABASE_URL must use postgres:// or postgresql://.");
  }
  if (!url.pathname.replace(/^\/+/, "") || !(url.searchParams.get("host") ?? url.hostname) || !url.username) {
    throw new Error(
      "FIELDLOOP_DATABASE_URL must include a host, database name and user.",
    );
  }
}

function parseArguments(argumentsList) {
  const options = { printSql: false, orgId: undefined, outputDir: DEFAULT_OUTPUT_DIR };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--print-sql") {
      options.printSql = true;
    } else if (argument === "--org-id" || argument === "--output-dir") {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(argument + " requires a value.");
      }
      if (argument === "--org-id") {
        options.orgId = value;
      } else {
        options.outputDir = value;
      }
      index += 1;
    } else if (argument === "--help") {
      options.help = true;
    } else {
      throw new Error("Unknown argument: " + argument);
    }
  }
  return options;
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  FIELDLOOP_ORG_ID=<org-id> FIELDLOOP_DATABASE_URL=<postgres-url> node data/synthetic/dl-01/seed.mjs",
      "  node data/synthetic/dl-01/seed.mjs --print-sql --org-id <org-id>",
      "",
    ].join("\n"),
  );
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const orgId = options.orgId ?? process.env.FIELDLOOP_ORG_ID;
  if (!orgId || orgId.trim().length === 0) {
    throw new Error("Set FIELDLOOP_ORG_ID or pass --org-id.");
  }
  const dataset = buildDataset();
  const databaseUrl = process.env.FIELDLOOP_DATABASE_URL;
  if (!options.printSql && !databaseUrl) {
    throw new Error(
      "Set FIELDLOOP_DATABASE_URL to the target database before loading the seed.",
    );
  }
  if (!options.printSql) {
    validateConnectionString(databaseUrl);
  }
  const database = new Kysely({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString: options.printSql ? undefined : databaseUrl,
        max: 1,
        connectionTimeoutMillis: 10_000,
      }),
    }),
  });
  try {
    if (options.printSql) {
      const queries = buildSeedQueries(database, dataset, orgId).map((query) => {
        const { sql: querySql, parameters } = query.compile();
        return { sql: querySql, parameters };
      });
      process.stdout.write(JSON.stringify(queries, null, 2) + "\n");
      return;
    }
    await writeDataset(options.outputDir);
    await loadSeed(database, dataset, orgId);
  } finally {
    await database.destroy();
  }
  process.stdout.write(
    "Loaded the synthetic DL-01 Asset, " +
      dataset.segments.features.length +
      " Segments and " +
      dataset.facilities.features.length +
      " Facilities for Organisation " +
      orgId +
      ".\n",
  );
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedAsScript) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Seed failed.");
    process.exitCode = 1;
  });
}
