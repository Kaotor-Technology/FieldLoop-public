import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
const ORGANISATION_NAME = "FieldLoop Demo Organisation (SYNTHETIC)";
const BOWTIE_SEED_URL = new URL("./bowtie-a.json", import.meta.url);

function readBowtieSeed() {
  return JSON.parse(readFileSync(BOWTIE_SEED_URL, "utf8"));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value, fieldName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Bowtie A seed requires ${fieldName}.`);
  }
}

function validateBowtieSeed(seed) {
  if (!isRecord(seed)) {
    throw new Error("Bowtie A seed must be a JSON object.");
  }
  for (const fieldName of ["id", "assetCode", "hazard", "topEvent", "domain", "status", "version"]) {
    requireString(seed[fieldName], fieldName);
  }
  if (!isRecord(seed.metadata)) {
    throw new Error("Bowtie A seed requires metadata.");
  }
  if (seed.metadata.label !== "SYNTHETIC" || seed.metadata.simulated !== true) {
    throw new Error("Bowtie A seed metadata must label the data SYNTHETIC and simulated.");
  }
  requireString(seed.metadata.classification, "metadata.classification");
  requireString(seed.metadata.parameterBasis, "metadata.parameterBasis");
  if (!Number.isFinite(Date.parse(seed.metadata.simulationStartsAt))) {
    throw new Error("Bowtie A seed requires a valid metadata.simulationStartsAt.");
  }
  for (const fieldName of ["threats", "consequences", "barriers", "independenceGroups", "paths"]) {
    if (!Array.isArray(seed[fieldName]) || seed[fieldName].length === 0) {
      throw new Error(`Bowtie A seed requires a non-empty ${fieldName} array.`);
    }
  }

  const entities = [
    ...seed.threats.map((item) => ["Threat", item]),
    ...seed.consequences.map((item) => ["Consequence", item]),
    ...seed.barriers.map((item) => ["Barrier", item]),
    ...seed.independenceGroups.map((item) => ["Independence Group", item]),
  ];
  const entityIds = new Set();
  for (const [entityName, entity] of entities) {
    if (!isRecord(entity)) {
      throw new Error(`Bowtie A seed contains an invalid ${entityName}.`);
    }
    requireString(entity.id, `${entityName}.id`);
    if (entityIds.has(entity.id)) {
      throw new Error(`Bowtie A seed repeats entity ID ${entity.id}.`);
    }
    entityIds.add(entity.id);
  }

  const threatIds = new Set(seed.threats.map((threat) => threat.id));
  const consequenceIds = new Set(seed.consequences.map((consequence) => consequence.id));
  const barriersById = new Map(seed.barriers.map((barrier) => [barrier.id, barrier]));
  const groupsById = new Map(seed.independenceGroups.map((group) => [group.id, group]));
  const preventiveTargets = new Set();
  const mitigativeTargets = new Set();
  const barrierUsage = new Set();
  const pathIds = new Set();

  for (const threat of seed.threats) {
    requireString(threat.name, `Threat ${threat.id}.name`);
    if (!Number.isFinite(threat.frequencyPerYear) || threat.frequencyPerYear <= 0) {
      throw new Error(`Threat ${threat.id} requires a positive simulated frequencyPerYear.`);
    }
  }
  for (const consequence of seed.consequences) {
    requireString(consequence.name, `Consequence ${consequence.id}.name`);
    if (!isRecord(consequence.severity) || Object.keys(consequence.severity).length === 0) {
      throw new Error(`Consequence ${consequence.id} requires a severity dimension.`);
    }
    if (Object.values(consequence.severity).some((band) => !Number.isInteger(band) || band < 1 || band > 5)) {
      throw new Error(`Consequence ${consequence.id} has a severity band outside 1–5.`);
    }
    if (!Number.isFinite(consequence.conditionalProbability) || consequence.conditionalProbability < 0 || consequence.conditionalProbability > 1) {
      throw new Error(`Consequence ${consequence.id} requires a conditional probability from 0 to 1.`);
    }
  }
  for (const barrier of seed.barriers) {
    requireString(barrier.name, `Barrier ${barrier.id}.name`);
    requireString(barrier.performanceStandard, `Barrier ${barrier.id}.performanceStandard`);
    requireString(barrier.evidenceInterval, `Barrier ${barrier.id}.evidenceInterval`);
    if (!["technical", "organisational", "human"].includes(barrier.type)) {
      throw new Error(`Barrier ${barrier.id} has an invalid type.`);
    }
    if (!["preventive", "mitigative"].includes(barrier.side)) {
      throw new Error(`Barrier ${barrier.id} has an invalid side.`);
    }
    const minimumPfd = barrier.type === "technical" ? 0.01 : 0.1;
    if (!Number.isFinite(barrier.pfdBand) || barrier.pfdBand < minimumPfd || barrier.pfdBand > 1) {
      throw new Error(`Barrier ${barrier.id} violates the PRD AS-4 PFD ceiling for ${barrier.type}.`);
    }
    if (!["healthy", "degraded", "failed", "unverified"].includes(barrier.health)) {
      throw new Error(`Barrier ${barrier.id} has an invalid Health value.`);
    }
    if (!isRecord(barrier.triad)) {
      throw new Error(`Barrier ${barrier.id} requires the Validation Triad.`);
    }
    for (const checkName of ["effective", "independent", "auditable"]) {
      const check = barrier.triad[checkName];
      if (!isRecord(check) || check.pass !== true) {
        throw new Error(`Barrier ${barrier.id} must pass the ${checkName} Validation Triad check.`);
      }
      requireString(check.justification, `Barrier ${barrier.id} ${checkName} justification`);
    }
    if (!Array.isArray(barrier.evidence) || barrier.evidence.length < 2) {
      throw new Error(`Barrier ${barrier.id} requires an Evidence history of at least two records.`);
    }
    for (const evidence of barrier.evidence) {
      requireString(evidence.id, `Barrier ${barrier.id} Evidence.id`);
      requireString(evidence.kind, `Evidence ${evidence.id}.kind`);
      requireString(evidence.source, `Evidence ${evidence.id}.source`);
      if (!Number.isFinite(Date.parse(evidence.observedAt))) {
        throw new Error(`Evidence ${evidence.id} requires a valid observedAt timestamp.`);
      }
    }
    if (barrier.independenceGroupId && !groupsById.has(barrier.independenceGroupId)) {
      throw new Error(`Barrier ${barrier.id} references an unknown Independence Group.`);
    }
    for (const factor of barrier.degradationFactors ?? []) {
      requireString(factor.id, `Barrier ${barrier.id} DegradationFactor.id`);
      requireString(factor.description, `Degradation Factor ${factor.id}.description`);
      if (!Array.isArray(factor.controls) || factor.controls.length === 0) {
        throw new Error(`Degradation Factor ${factor.id} requires a Degradation Control.`);
      }
      for (const control of factor.controls) {
        requireString(control.id, `Degradation Factor ${factor.id} control.id`);
        requireString(control.description, `Degradation Control ${control.id}.description`);
      }
    }
  }
  for (const group of seed.independenceGroups) {
    requireString(group.cause, `Independence Group ${group.id}.cause`);
    const members = seed.barriers.filter((barrier) => barrier.independenceGroupId === group.id);
    if (members.length < 2) {
      throw new Error(`Independence Group ${group.id} must contain at least two Barriers.`);
    }
  }

  for (const path of seed.paths) {
    requireString(path.id, "path.id");
    if (pathIds.has(path.id)) {
      throw new Error(`Bowtie A seed repeats path ID ${path.id}.`);
    }
    pathIds.add(path.id);
    const validTarget = path.side === "preventive"
      ? threatIds.has(path.targetId)
      : path.side === "mitigative" && consequenceIds.has(path.targetId);
    if (!validTarget) {
      throw new Error(`Path ${path.id} does not target a ${path.side === "preventive" ? "Threat" : "Consequence"}.`);
    }
    if (!Array.isArray(path.barrierIds) || path.barrierIds.length === 0) {
      throw new Error(`Path ${path.id} requires at least one Barrier.`);
    }
    const targetSet = path.side === "preventive" ? preventiveTargets : mitigativeTargets;
    targetSet.add(path.targetId);
    for (const barrierId of path.barrierIds) {
      const barrier = barriersById.get(barrierId);
      if (!barrier || barrier.side !== path.side) {
        throw new Error(`Path ${path.id} references a missing or wrong-side Barrier ${barrierId}.`);
      }
      if (path.barrierIds.indexOf(barrierId) !== path.barrierIds.lastIndexOf(barrierId)) {
        throw new Error(`Path ${path.id} repeats Barrier ${barrierId}.`);
      }
      barrierUsage.add(barrierId);
    }
  }
  if (seed.threats.some((threat) => !preventiveTargets.has(threat.id))) {
    throw new Error("Every Threat must have a Preventive path to the Top Event.");
  }
  if (seed.consequences.some((consequence) => !mitigativeTargets.has(consequence.id))) {
    throw new Error("Every Consequence must have a Mitigative path from the Top Event.");
  }
  if (seed.barriers.some((barrier) => !barrierUsage.has(barrier.id))) {
    throw new Error("Every Barrier must be used by at least one Bowtie path.");
  }
  return seed;
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
  if (typeof classification !== "string" || classification.trim().length === 0) {
    throw new Error(`Feature ${feature.id} requires classification.`);
  }
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

  // IDs this run loads, per table, in the order the tables are first written.
  const loadedIds = new Map();
  const track = (table, id) => {
    loadedIds.set(table, [...(loadedIds.get(table) ?? []), id]);
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

  // One row per Organisation, whichever seed loads it first; no seed removes it.
  statements.push(insertById(database, "app.organisation", {
    id: deterministicUuid("fieldloop:organisation:" + orgId),
    org_id: orgId,
    name: ORGANISATION_NAME,
    simulated,
    classification,
    created_by: CREATED_BY,
  }));

  const bowtieId = databaseId(orgId, `bowtie:${bowtieSeed.id}`);
  const databaseIdFor = (entityType, entityId) => databaseId(orgId, `${entityType}:${entityId}`);
  statements.push(upsert("app.bowtie", {
    id: bowtieId,
    org_id: orgId,
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
  for (const [table, ids] of [...loadedIds].reverse()) {
    statements.push(stale(table).where("id", "not in", ids));
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

// dbmate and Cloud SQL name a Unix socket directory with an empty host and ?socket= or ?host=.
// The WHATWG URL parser rejects an empty host, and the driver rejects one followed by a port, so
// the URL is read and passed on with a placeholder host. The driver connects to ?host= instead.
const EMPTY_HOST = "localhost";

// Returns FIELDLOOP_DATABASE_URL in the form the PostgreSQL driver reads.
export function driverConnectionString(connectionString) {
  if (!/^postgres(ql)?:\/\//.test(connectionString)) {
    throw new Error("FIELDLOOP_DATABASE_URL must use postgres:// or postgresql://.");
  }
  const withHost = connectionString.replace(/^([a-z]+:\/\/(?:[^/?#@]*@)?)(?=\/|:\d+\/)/, "$1" + EMPTY_HOST);
  const hostWasEmpty = withHost !== connectionString;
  let url;
  try {
    url = new URL(withHost);
  } catch {
    throw new Error("FIELDLOOP_DATABASE_URL must be a valid PostgreSQL URL.");
  }
  const socket = url.searchParams.get("socket");
  if (socket !== null) {
    url.searchParams.delete("socket");
    if (!url.searchParams.has("host")) {
      url.searchParams.set("host", socket);
    }
  }
  const hasHost = Boolean(url.searchParams.get("host")) || !hostWasEmpty;
  if (!url.pathname.replace(/^\/+/, "") || !hasHost || !url.username) {
    throw new Error(
      "FIELDLOOP_DATABASE_URL must include a host, database name and user.",
    );
  }
  return url.toString();
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
