import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildDataset, writeDataset } from "./generate.mjs";

const UUID_NAMESPACE_URL = Buffer.from(
  "6ba7b8119dad11d180b400c04fd430c8",
  "hex",
);
const DEFAULT_OUTPUT_DIR = new URL(".", import.meta.url);
const CREATED_BY = "seed:dl-01";
const CLASSIFICATION = "internal";

function sqlLiteral(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function jsonbLiteral(value) {
  return sqlLiteral(JSON.stringify(value)) + "::jsonb";
}

function geometryExpression(geometry) {
  return (
    "ST_SetSRID(ST_GeomFromGeoJSON(" +
    sqlLiteral(JSON.stringify(geometry)) +
    "), 4326)"
  );
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

function insertAsset({ id, orgId, type, parentId, domainPack, geometry, attributes }) {
  const parentValue = parentId === null ? "NULL" : sqlLiteral(parentId);
  const domainPackValue = domainPack === null ? "NULL" : sqlLiteral(domainPack);
  return [
    "INSERT INTO app.asset",
    "  (id, org_id, type, parent_id, domain_pack, geom, attributes, simulated, classification, created_by)",
    "VALUES",
    "  (" +
      [
        sqlLiteral(id),
        sqlLiteral(orgId),
        sqlLiteral(type),
        parentValue,
        domainPackValue,
        geometryExpression(geometry),
        jsonbLiteral(attributes),
        "TRUE",
        sqlLiteral(CLASSIFICATION),
        sqlLiteral(CREATED_BY),
      ].join(", ") +
      ")",
    "ON CONFLICT (id) DO UPDATE SET",
    "  org_id = EXCLUDED.org_id,",
    "  type = EXCLUDED.type,",
    "  parent_id = EXCLUDED.parent_id,",
    "  domain_pack = EXCLUDED.domain_pack,",
    "  geom = EXCLUDED.geom,",
    "  attributes = EXCLUDED.attributes,",
    "  simulated = EXCLUDED.simulated,",
    "  classification = EXCLUDED.classification,",
    "  created_by = EXCLUDED.created_by;",
  ].join("\n");
}

function insertSegment({ id, orgId, assetId, geometry, properties }) {
  return [
    "INSERT INTO app.segment",
    "  (id, org_id, asset_id, chainage_from, chainage_to, geom, simulated, classification, created_by)",
    "VALUES",
    "  (" +
      [
        sqlLiteral(id),
        sqlLiteral(orgId),
        sqlLiteral(assetId),
        String(properties.chainage_from_m),
        String(properties.chainage_to_m),
        geometryExpression(geometry),
        "TRUE",
        sqlLiteral(CLASSIFICATION),
        sqlLiteral(CREATED_BY),
      ].join(", ") +
      ")",
    "ON CONFLICT (id) DO UPDATE SET",
    "  org_id = EXCLUDED.org_id,",
    "  asset_id = EXCLUDED.asset_id,",
    "  chainage_from = EXCLUDED.chainage_from,",
    "  chainage_to = EXCLUDED.chainage_to,",
    "  geom = EXCLUDED.geom,",
    "  simulated = EXCLUDED.simulated,",
    "  classification = EXCLUDED.classification,",
    "  created_by = EXCLUDED.created_by;",
  ].join("\n");
}

export function buildSeedSql(dataset, orgId) {
  if (typeof orgId !== "string" || orgId.trim().length === 0) {
    throw new Error("An Organisation ID is required.");
  }

  const routeFeature = dataset.route.features[0];
  const pipelineId = databaseId(orgId, "asset:dl-01");
  const statements = [
    "-- Synthetic DL-01 seed. psql applies this file as one transaction.",
    insertAsset({
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
      insertAsset({
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
      insertSegment({
        id: databaseId(orgId, "segment:" + segment.id),
        orgId,
        assetId: pipelineId,
        geometry: segment.geometry,
        properties: segment.properties,
      }),
    );
  }

  return statements.join("\n\n") + "\n";
}

function connectionEnvironment(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("FIELDLOOP_DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("FIELDLOOP_DATABASE_URL must use postgres:// or postgresql://.");
  }

  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const socketHost = url.searchParams.get("host");
  const host = socketHost ?? decodeURIComponent(url.hostname);
  if (!databaseName || !host || !url.username) {
    throw new Error(
      "FIELDLOOP_DATABASE_URL must include a host, database name and user.",
    );
  }

  const environment = {
    ...process.env,
    PGHOST: host,
    PGPORT: url.port || "5432",
    PGDATABASE: databaseName,
    PGUSER: decodeURIComponent(url.username),
  };
  delete environment.FIELDLOOP_DATABASE_URL;
  if (url.password) {
    environment.PGPASSWORD = decodeURIComponent(url.password);
  }
  const sslMode = url.searchParams.get("sslmode");
  if (sslMode) {
    environment.PGSSLMODE = sslMode;
  }
  return environment;
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
  const sql = buildSeedSql(dataset, orgId);

  if (options.printSql) {
    process.stdout.write(sql);
    return;
  }

  const databaseUrl = process.env.FIELDLOOP_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "Set FIELDLOOP_DATABASE_URL to the target database before loading the seed.",
    );
  }
  await writeDataset(options.outputDir);

  const result = spawnSync(
    "psql",
    ["--no-psqlrc", "--quiet", "--set=ON_ERROR_STOP=1", "--single-transaction"],
    {
      env: connectionEnvironment(databaseUrl),
      input: sql,
      encoding: "utf8",
    },
  );
  if (result.error) {
    throw new Error("Could not run psql: " + result.error.message);
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim();
    throw new Error(
      "DL-01 seed transaction failed." +
        (detail.length > 0 ? "\n" + detail : ""),
    );
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
