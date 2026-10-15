import { deterministicUuid, driverConnectionString, requireClassification, validateBowtieSeed } from "../common.mjs";
export { driverConnectionString } from "../common.mjs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { buildDataset, writeDataset } from "../../../data/synthetic/dl-01/generate.mjs";

// The generator, the Bowtie A seed file and the generated GeoJSON live with the synthetic data.
const SEED_DATA_URL = new URL("../../../data/synthetic/dl-01/", import.meta.url);
const DEFAULT_OUTPUT_DIR = SEED_DATA_URL;
const CREATED_BY = "seed:dl-01";
const ORGANISATION_NAME = "FieldLoop Demo Organisation (SYNTHETIC)";
// The PRD 9.1 classes, as the schema stores them. Asset geometry is Highly Restricted and
// Bowtie and Barrier records are Confidential; the seed data states its class itself.
const ORGANISATION_CLASSIFICATION = "INTERNAL";

// Tables whose rows this seed owns, parents before children. bowtie_asset has no id and is
// handled apart; organisation is shared with other seeds and never cleaned.
const OWNED_TABLES = [
  "app.asset",
  "app.segment",
  "app.bowtie",
  "app.threat",
  "app.consequence",
  "app.independence_group",
  "app.barrier",
  "app.barrier_path",
  "app.degradation_factor",
  "app.degradation_control",
  "app.evidence",
];
const BOWTIE_SEED_URL = new URL("bowtie-a.json", SEED_DATA_URL);

function readBowtieSeed() {
  return JSON.parse(readFileSync(BOWTIE_SEED_URL, "utf8"));
}

function jsonbExpression(value) {
  return sql`${JSON.stringify(value)}::jsonb`;
}

function insertById(database, table, values) {
  return database
    .insertInto(table)
    .values(values)
    .onConflict((conflict) => conflict.column("id").doUpdateSet((expression) =>
      Object.fromEntries(
        Object.keys(values)
          .filter((column) => column !== "id")
          .map((column) => [column, expression.ref(`excluded.${column}`)]),
      ),
    ));
}

function geometryExpression(geometry) {
  return sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geometry)}::text), 4326)`;
}

function databaseId(orgId, entityKey) {
  return deterministicUuid("fieldloop:dl-01:" + orgId + ":" + entityKey);
}

function insertAsset(database, { id, orgId, type, parentId, domainPack, geometry, attributes, simulated, classification }) {
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
      simulated,
      classification,
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

function insertSegment(database, { id, orgId, assetId, geometry, properties, simulated, classification }) {
  return database
    .insertInto("app.segment")
    .values({
      id,
      org_id: orgId,
      asset_id: assetId,
      chainage_from: properties.chainage_from_m,
      chainage_to: properties.chainage_to_m,
      geom: geometryExpression(geometry),
      simulated,
      classification,
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

// A generated feature states its own labelling; the loader does not assume it.
function featureLabelling(feature) {
  const { label, simulated, classification } = feature.properties;
  if (label !== "SYNTHETIC" || simulated !== true) {
    throw new Error(`Feature ${feature.id} must be labelled SYNTHETIC and simulated.`);
  }
  requireClassification(classification, `Feature ${feature.id}`);
  return { simulated, classification };
}

export function buildSeedQueries(database, dataset, orgId, bowtieSeed = readBowtieSeed()) {
  if (typeof orgId !== "string" || orgId.trim().length === 0) {
    throw new Error("An Organisation ID is required.");
  }
  validateBowtieSeed(bowtieSeed);
  const { simulated, classification } = bowtieSeed.metadata;

  const routeFeature = dataset.route.features[0];
  if (bowtieSeed.assetCode !== routeFeature.properties.asset_code) {
    throw new Error("Bowtie A seed assetCode must match the generated DL-01 Asset.");
  }
  const features = [routeFeature, ...dataset.facilities.features, ...dataset.segments.features];
  const labelling = new Map(features.map((feature) => [feature.id, featureLabelling(feature)]));

  // IDs this run loads, per owned table.
  const loadedIds = new Map(OWNED_TABLES.map((table) => [table, []]));
  const track = (table, id) => {
    if (!loadedIds.has(table)) {
      throw new Error(`${table} is not a table this seed owns.`);
    }
    loadedIds.get(table).push(id);
    return id;
  };
  const upsert = (table, values) => {
    track(table, values.id);
    return insertById(database, table, values);
  };

  const pipelineId = track("app.asset", databaseId(orgId, "asset:dl-01"));
  const statements = [
    insertAsset(database, {
      id: pipelineId,
      orgId,
      type: "linear",
      parentId: null,
      domainPack: "pipeline-integrity",
      geometry: routeFeature.geometry,
      ...labelling.get(routeFeature.id),
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
    const facilityId = track("app.asset", databaseId(orgId, "asset:" + facility.id));
    statements.push(
      insertAsset(database, {
        id: facilityId,
        orgId,
        type: "facility",
        parentId: pipelineId,
        domainPack: "pipeline-integrity",
        geometry: facility.geometry,
        ...labelling.get(facility.id),
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
        id: track("app.segment", databaseId(orgId, "segment:" + segment.id)),
        orgId,
        assetId: pipelineId,
        geometry: segment.geometry,
        properties: segment.properties,
        ...labelling.get(segment.id),
      }),
    );
  }

  // One row per Organisation: every seed for it upserts this same ID, and none removes it.
  statements.push(insertById(database, "app.organisation", {
    id: deterministicUuid("fieldloop:organisation:" + orgId),
    org_id: orgId,
    name: ORGANISATION_NAME,
    simulated,
    classification: ORGANISATION_CLASSIFICATION,
    created_by: CREATED_BY,
  }));

  const bowtieId = databaseId(orgId, `bowtie:${bowtieSeed.id}`);
  const databaseIdFor = (entityType, entityId) => databaseId(orgId, `${entityType}:${entityId}`);
  statements.push(upsert("app.bowtie", {
    id: bowtieId,
    org_id: orgId,
    code: bowtieSeed.id,
    hazard: bowtieSeed.hazard,
    top_event: bowtieSeed.topEvent,
    domain: bowtieSeed.domain,
    status: bowtieSeed.status,
    version: bowtieSeed.version,
    simulated,
    classification,
    created_by: CREATED_BY,
  }));
  statements.push(database
    .insertInto("app.bowtie_asset")
    .values({
      bowtie_id: bowtieId,
      asset_id: pipelineId,
      org_id: orgId,
      simulated,
      classification,
      created_by: CREATED_BY,
    })
    .onConflict((conflict) => conflict
      .columns(["bowtie_id", "asset_id"])
      .doUpdateSet((expression) => ({
        org_id: expression.ref("excluded.org_id"),
        simulated: expression.ref("excluded.simulated"),
        classification: expression.ref("excluded.classification"),
        created_by: expression.ref("excluded.created_by"),
      })),
    ));

  for (const threat of bowtieSeed.threats) {
    statements.push(upsert("app.threat", {
      id: databaseIdFor("threat", threat.id),
      org_id: orgId,
      bowtie_id: bowtieId,
      name: threat.name,
      frequency_per_year: threat.frequencyPerYear,
      simulated,
      classification,
      created_by: CREATED_BY,
    }));
  }

  for (const consequence of bowtieSeed.consequences) {
    statements.push(upsert("app.consequence", {
      id: databaseIdFor("consequence", consequence.id),
      org_id: orgId,
      bowtie_id: bowtieId,
      name: consequence.name,
      severity: jsonbExpression(consequence.severity),
      p_conditional: consequence.conditionalProbability,
      simulated,
      classification,
      created_by: CREATED_BY,
    }));
  }

  for (const group of bowtieSeed.independenceGroups) {
    statements.push(upsert("app.independence_group", {
      id: databaseIdFor("independence_group", group.id),
      org_id: orgId,
      bowtie_id: bowtieId,
      cause: group.cause,
      simulated,
      classification,
      created_by: CREATED_BY,
    }));
  }

  for (const barrier of bowtieSeed.barriers) {
    const barrierId = databaseIdFor("barrier", barrier.id);
    statements.push(upsert("app.barrier", {
      id: barrierId,
      org_id: orgId,
      name: barrier.name,
      type: barrier.type,
      side: barrier.side,
      pfd_band: barrier.pfdBand,
      health: barrier.health,
      evidence_interval: barrier.evidenceInterval,
      performance_standard: barrier.performanceStandard,
      independence_group_id: barrier.independenceGroupId
        ? databaseIdFor("independence_group", barrier.independenceGroupId)
        : null,
      code: barrier.id,
      triad: jsonbExpression(barrier.triad),
      simulated,
      classification,
      created_by: CREATED_BY,
    }));
  }

  for (const path of bowtieSeed.paths) {
    for (const [index, barrierKey] of path.barrierIds.entries()) {
      const pathTargetId = path.side === "preventive"
        ? databaseIdFor("threat", path.targetId)
        : databaseIdFor("consequence", path.targetId);
      statements.push(upsert("app.barrier_path", {
        id: databaseIdFor("barrier_path", `${path.id}:${barrierKey}`),
        org_id: orgId,
        barrier_id: databaseIdFor("barrier", barrierKey),
        threat_id: path.side === "preventive" ? pathTargetId : null,
        consequence_id: path.side === "mitigative" ? pathTargetId : null,
        position: index + 1,
        simulated,
        classification,
        created_by: CREATED_BY,
      }));
    }
  }

  for (const barrier of bowtieSeed.barriers) {
    for (const factor of barrier.degradationFactors ?? []) {
      const factorId = databaseIdFor("degradation_factor", factor.id);
      statements.push(upsert("app.degradation_factor", {
        id: factorId,
        org_id: orgId,
        barrier_id: databaseIdFor("barrier", barrier.id),
        description: factor.description,
        simulated,
        classification,
        created_by: CREATED_BY,
      }));
      for (const control of factor.controls) {
        statements.push(upsert("app.degradation_control", {
          id: databaseIdFor("degradation_control", control.id),
          org_id: orgId,
          degradation_factor_id: factorId,
          description: control.description,
          simulated,
          classification,
          created_by: CREATED_BY,
        }));
      }
    }
    for (const evidence of barrier.evidence) {
      statements.push(upsert("app.evidence", {
        id: databaseIdFor("evidence", evidence.id),
        org_id: orgId,
        barrier_id: databaseIdFor("barrier", barrier.id),
        kind: evidence.kind,
        source: evidence.source,
        observed_at: evidence.observedAt,
        blob_uri: evidence.blobUri ?? null,
        simulated,
        classification,
        created_by: CREATED_BY,
      }));
    }
  }

  // Rows an earlier run of this seed loaded that are no longer in the seed files are removed,
  // children before parents. Rows the seed did not create are left alone.
  const stale = (table) => database
    .deleteFrom(table)
    .where("org_id", "=", orgId)
    .where("created_by", "=", CREATED_BY);
  statements.push(stale("app.bowtie_asset").where((expression) => expression.not(expression.and([
    expression("bowtie_id", "=", bowtieId),
    expression("asset_id", "=", pipelineId),
  ]))));
  for (const table of [...OWNED_TABLES].reverse()) {
    const ids = loadedIds.get(table);
    // A table the seed files no longer fill is emptied of this seed's rows.
    statements.push(ids.length === 0 ? stale(table) : stale(table).where("id", "not in", ids));
  }

  return statements;
}

export async function loadSeed(database, dataset, orgId, bowtieSeed = readBowtieSeed()) {
  await database.transaction().execute(async (transaction) => {
    for (const query of buildSeedQueries(transaction, dataset, orgId, bowtieSeed)) {
      await query.execute();
    }
  });
}

// Reads back what the Organisation now holds, so a job log is evidence of the load.
async function readLoadedState(database, orgId, queries) {
  const tables = [...new Set(
    queries.map((query) => /^insert into "app"\."([a-z_]+)"/.exec(query.compile().sql)?.[1]),
  )].filter((table) => table !== undefined);
  if (tables.length === 0) {
    throw new Error("No seeded table was recognised in the seed statements.");
  }
  const rowCounts = [];
  for (const table of tables) {
    const { count } = await database
      .selectFrom(`app.${table}`)
      .select((expression) => expression.fn.countAll().as("count"))
      .where("org_id", "=", orgId)
      .executeTakeFirstOrThrow();
    rowCounts.push(`${table} ${count}`);
  }
  // A Segment is broken when it has no Chainage, is empty, or does not start where the previous one
  // ends; the first one must start at 0. db/test/seed/dl_01_loaded.sql applies the same rule.
  const { rows: [pipeline] } = await sql`
    WITH pipeline AS (
      SELECT id FROM app.asset WHERE org_id = ${orgId} AND attributes->>'asset_code' = 'DL-01'
    ), ordered AS (
      SELECT chainage_from, chainage_to, lag(chainage_to) OVER (ORDER BY chainage_from) AS previous_to
      FROM app.segment
      WHERE org_id = ${orgId} AND asset_id IN (SELECT id FROM pipeline)
    )
    SELECT (SELECT count(*) FROM pipeline)::int AS assets,
           count(*)::int AS segments,
           (count(*) FILTER (
             WHERE chainage_from IS NULL OR chainage_to IS NULL OR chainage_from >= chainage_to
                OR chainage_from IS DISTINCT FROM coalesce(previous_to, 0)
           ))::int AS broken,
           min(chainage_from)::float8 AS chainage_from,
           max(chainage_to)::float8 AS chainage_to
    FROM ordered
  `.execute(database);
  return { rowCounts, pipeline };
}

// Lists where the read-back differs from what the seed loads. An empty list means the
// Organisation holds one DL-01 pipeline whose Segments cover its whole length.
export function loadedStateProblems(pipeline, routeLengthM) {
  const problems = [];
  if (pipeline.assets !== 1) {
    problems.push(`${pipeline.assets} DL-01 pipeline Assets instead of 1`);
  }
  if (pipeline.segments === 0) {
    problems.push("no Segments on the DL-01 pipeline");
    return problems;
  }
  if (pipeline.chainage_from !== 0) {
    problems.push(`Segments start at Chainage ${pipeline.chainage_from} m instead of 0`);
  }
  if (pipeline.chainage_to !== routeLengthM) {
    problems.push(`Segments end at Chainage ${pipeline.chainage_to} m instead of ${routeLengthM}`);
  }
  if (pipeline.broken !== 0) {
    problems.push(`${pipeline.broken} gaps or overlaps between Segments`);
  }
  return problems;
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
      "  FIELDLOOP_ORG_ID=<org-id> FIELDLOOP_DATABASE_URL=<postgres-url> node db/seed/dl-01/seed.mjs",
      "  node db/seed/dl-01/seed.mjs --print-sql --org-id <org-id>",
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
  const bowtieSeed = validateBowtieSeed(readBowtieSeed());
  const databaseUrl = process.env.FIELDLOOP_DATABASE_URL;
  if (!options.printSql && !databaseUrl) {
    throw new Error(
      "Set FIELDLOOP_DATABASE_URL to the target database before loading the seed.",
    );
  }
  let loadedState;
  const database = new Kysely({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString: options.printSql ? undefined : driverConnectionString(databaseUrl),
        max: 1,
        connectionTimeoutMillis: 10_000,
      }),
    }),
  });
  try {
    if (options.printSql) {
      const queries = buildSeedQueries(database, dataset, orgId, bowtieSeed).map((query) => {
        const { sql: querySql, parameters } = query.compile();
        return { sql: querySql, parameters };
      });
      process.stdout.write(JSON.stringify(queries, null, 2) + "\n");
      return;
    }
    await writeDataset(options.outputDir);
    await loadSeed(database, dataset, orgId, bowtieSeed);
    try {
      loadedState = await readLoadedState(
        database,
        orgId,
        buildSeedQueries(database, dataset, orgId, bowtieSeed),
      );
    } catch (error) {
      throw new Error(
        "The seed was loaded and committed, but reading it back failed: " +
          (error instanceof Error ? error.message : String(error)),
        { cause: error },
      );
    }
  } finally {
    await database.destroy();
  }
  process.stdout.write(
    "Loaded the synthetic DL-01 Asset, " +
      dataset.segments.features.length +
      " Segments, " +
      dataset.facilities.features.length +
      " Facilities, Bowtie A and its Threats, Consequences, Barriers, Evidence for Organisation " +
      orgId +
      ".\n" +
      "Rows for this Organisation: " +
      loadedState.rowCounts.join(", ") +
      ".\n" +
      "DL-01 pipeline Assets: " +
      loadedState.pipeline.assets +
      ". Segments: " +
      loadedState.pipeline.segments +
      ", from Chainage " +
      loadedState.pipeline.chainage_from +
      " to " +
      loadedState.pipeline.chainage_to +
      " m, with " +
      loadedState.pipeline.broken +
      " gaps or overlaps.\n",
  );
  // The summary above is printed first, so a failing job still logs what the database holds.
  const problems = loadedStateProblems(
    loadedState.pipeline,
    dataset.route.features[0].properties.length_m,
  );
  if (problems.length > 0) {
    throw new Error(
      "The seed was loaded and committed, but the database does not hold what it loads: " +
        problems.join("; ") +
        ".",
    );
  }
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
