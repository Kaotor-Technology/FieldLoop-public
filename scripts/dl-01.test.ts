import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type Coordinate = [number, number];
type LineString = { type: "LineString"; coordinates: Coordinate[] };
type Point = { type: "Point"; coordinates: Coordinate };
type Geometry = LineString | Point;
type Feature = {
  type: "Feature";
  id: string;
  geometry: Geometry;
  properties: Record<string, unknown>;
};
type FeatureCollection = { type: "FeatureCollection"; features: Feature[] };
type SeedQuery = { sql: string; parameters: unknown[] };
type TransactionResult = {
  queries: SeedQuery[];
  connections: number;
  releases: number;
  ended: boolean;
  error: string | null;
};
type BowtiePathFixture = {
  id: string;
  side: "preventive" | "mitigative";
  targetId: string;
  barrierIds: string[];
};
type BowtieFixture = {
  metadata: {
    label: string;
    simulated: boolean;
    classification: string;
    simulationStartsAt: string;
  };
  threats: { id: string; name: string; frequencyPerYear: number }[];
  consequences: { id: string; name: string; severity: Record<string, number>; conditionalProbability: number }[];
  barriers: {
    id: string;
    name: string;
    type: string;
    side: "preventive" | "mitigative";
    pfdBand: number;
    evidenceInterval: string;
    performanceStandard: string;
    triad: Record<string, { pass: boolean; justification: string }>;
    evidence: { id: string; observedAt: string }[];
    degradationFactors?: { description: string; controls: { description: string }[] }[];
  }[];
  paths: BowtiePathFixture[];
};

const repositoryRoot = resolve(".");
const generator = resolve("data/synthetic/dl-01/generate.mjs");
const seeder = resolve("data/synthetic/dl-01/seed.mjs");
const bowtieSeedFile = resolve("data/synthetic/dl-01/bowtie-a.json");
const generatedDirectories: string[] = [];

function readBowtieFixture(): BowtieFixture {
  return JSON.parse(readFileSync(bowtieSeedFile, "utf8")) as BowtieFixture;
}

function previewSeed(orgId: string): SeedQuery[] {
  return JSON.parse(execFileSync(
    process.execPath,
    [seeder, "--print-sql", "--org-id", orgId],
    { cwd: repositoryRoot, encoding: "utf8" },
  )) as SeedQuery[];
}

type DriverTarget = { host?: string; database?: string; user?: string; error?: string };

function readDriverTarget(databaseUrl: string): DriverTarget {
  // Ask the PostgreSQL driver what it would connect to, without connecting.
  const script = `
    import pg from 'pg';
    import { driverConnectionString } from './data/synthetic/dl-01/seed.mjs';
    try {
      const client = new pg.Client({ connectionString: driverConnectionString(process.argv[1]) });
      console.log(JSON.stringify({ host: client.host, database: client.database, user: client.user }));
    } catch (failure) {
      console.log(JSON.stringify({ error: failure.message }));
    }
  `;
  return JSON.parse(execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script, databaseUrl],
    { cwd: repositoryRoot, encoding: "utf8" },
  )) as DriverTarget;
}

type LoadedPipeline = {
  assets: number;
  segments: number;
  broken: number;
  chainage_from: number | null;
  chainage_to: number | null;
};

function readLoadedStateProblems(pipeline: LoadedPipeline): string[] {
  const script = `
    import { loadedStateProblems } from './data/synthetic/dl-01/seed.mjs';
    console.log(JSON.stringify(loadedStateProblems(JSON.parse(process.argv[1]), 180000)));
  `;
  return JSON.parse(execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script, JSON.stringify(pipeline)],
    { cwd: repositoryRoot, encoding: "utf8" },
  )) as string[];
}

function runSeedTransaction(failAt: number, mutation = "none"): TransactionResult {
  // Exercise Kysely's PostgreSQL driver without connecting to a database.
  const script = `
    import { readFileSync } from 'node:fs';
    import { Kysely, PostgresDialect } from 'kysely';
    import { buildDataset } from './data/synthetic/dl-01/generate.mjs';
    import { loadSeed } from './data/synthetic/dl-01/seed.mjs';
    const queries = [];
    let connections = 0, releases = 0, ended = false, error = null;
    const client = {
      async query(sql, parameters) {
        queries.push({ sql, parameters });
        if (queries.length === Number(process.argv[1])) {
          throw new Error('injected seed failure');
        }
        return { rows: [], rowCount: 1, command: 'INSERT' };
      },
      release() { releases += 1; },
    };
    const pool = {
      async connect() { connections += 1; return client; },
      async end() { ended = true; },
    };
    const database = new Kysely({ dialect: new PostgresDialect({ pool }) });
    const bowtieSeed = JSON.parse(readFileSync('./data/synthetic/dl-01/bowtie-a.json', 'utf8'));
    if (process.argv[2] === 'missing-classification') delete bowtieSeed.metadata.classification;
    if (process.argv[2] === 'mismatched-asset') bowtieSeed.assetCode = 'DL-02';
    if (process.argv[2] === 'missing-threat-path') {
      bowtieSeed.paths = bowtieSeed.paths.filter((path) => path.targetId !== 'third-party-excavation');
    }
    if (process.argv[2] === 'single-evidence') bowtieSeed.barriers[0].evidence.length = 1;
    if (process.argv[2] === 'unknown-classification') bowtieSeed.metadata.classification = 'internal';
    if (process.argv[2] === 'no-degradation-factors') {
      for (const barrier of bowtieSeed.barriers) delete barrier.degradationFactors;
    }
    const dataset = buildDataset();
    if (process.argv[2] === 'missing-segment-classification') delete dataset.segments.features[0].properties.classification;
    if (process.argv[2] === 'unlabelled-facility') dataset.facilities.features[0].properties.label = 'REAL';
    try {
      await loadSeed(database, dataset, "demo'pipeline", bowtieSeed);
    } catch (failure) {
      error = failure.message;
    } finally {
      await database.destroy();
    }
    console.log(JSON.stringify({ queries, connections, releases, ended, error }));
  `;
  return JSON.parse(execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", script, String(failAt), mutation],
    { cwd: repositoryRoot, encoding: "utf8" },
  )) as TransactionResult;
}

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "fieldloop-dl-01-"));
  generatedDirectories.push(directory);
  return directory;
}

function generateInto(directory: string) {
  execFileSync(process.execPath, [generator, "--output-dir", directory], {
    cwd: repositoryRoot,
  });
}

function readCollection(path: string): FeatureCollection {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    !("features" in value) ||
    !Array.isArray(value.features)
  ) {
    throw new Error("Invalid GeoJSON FeatureCollection.");
  }
  return value as FeatureCollection;
}

function firstFeature(collection: FeatureCollection): Feature {
  const value = collection.features[0];
  if (!value) {
    throw new Error("GeoJSON FeatureCollection is empty.");
  }
  return value;
}

function distanceMeters(start: Coordinate, end: Coordinate) {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(end[1] - start[1]);
  const longitudeDelta = radians(end[0] - start[0]);
  const startLatitude = radians(start[1]);
  const endLatitude = radians(end[1]);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(startLatitude) *
      Math.cos(endLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(haversine));
}

function lineLength(coordinates: Coordinate[]) {
  return coordinates.slice(1).reduce(
    (length, coordinate, index) => {
      const previous = coordinates[index];
      if (!previous) {
        throw new Error("LineString coordinate is missing.");
      }
      return length + distanceMeters(previous, coordinate);
    },
    0,
  );
}

function minimumDistanceToRoute(point: Coordinate, route: Coordinate[]) {
  let minimumDistance = Number.POSITIVE_INFINITY;
  for (const coordinate of route) {
    minimumDistance = Math.min(
      minimumDistance,
      distanceMeters(point, coordinate),
    );
  }
  return minimumDistance;
}

afterEach(() => {
  for (const directory of generatedDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("synthetic DL-01 route generator", () => {
  it("generates deterministic route, Segment and Facility GeoJSON", () => {
    const firstDirectory = temporaryDirectory();
    const secondDirectory = temporaryDirectory();
    generateInto(firstDirectory);
    generateInto(secondDirectory);

    for (const filename of [
      "route.geojson",
      "segments.geojson",
      "facilities.geojson",
    ]) {
      expect(readFileSync(join(firstDirectory, filename), "utf8")).toBe(
        readFileSync(join(secondDirectory, filename), "utf8"),
      );
    }
  });

  it("covers exactly 180 km with contiguous Segments and labelled data", () => {
    const directory = temporaryDirectory();
    generateInto(directory);
    const route = firstFeature(readCollection(join(directory, "route.geojson")));
    const segments = readCollection(join(directory, "segments.geojson")).features;
    const facilities = readCollection(join(directory, "facilities.geojson")).features;

    expect(route.properties.length_m).toBe(180_000);
    expect(route.properties.nominal_diameter_in).toBe(30);
    expect(route.properties.label).toBe("SYNTHETIC");
    expect(route.properties.simulated).toBe(true);
    expect(route.properties.classification).toBe("HIGHLY_RESTRICTED");
    expect(route.geometry.type).toBe("LineString");
    if (route.geometry.type !== "LineString") {
      throw new Error("Route must be a LineString.");
    }
    expect(lineLength(route.geometry.coordinates)).toBeCloseTo(180_000, 0);

    expect(segments).toHaveLength(6);
    const firstSegment = segments[0];
    const lastSegment = segments.at(-1);
    if (!firstSegment || !lastSegment) {
      throw new Error("Expected generated Segments.");
    }
    expect(firstSegment.properties.chainage_from_m).toBe(0);
    expect(lastSegment.properties.chainage_to_m).toBe(180_000);
    for (const [index, segment] of segments.entries()) {
      expect(segment.properties.chainage_from_m).toBe(index * 30_000);
      expect(segment.properties.chainage_to_m).toBe((index + 1) * 30_000);
      expect(segment.properties.simulated).toBe(true);
      expect(segment.properties.label).toBe("SYNTHETIC");
      expect(segment.geometry.type).toBe("LineString");
      if (segment.geometry.type !== "LineString") {
        throw new Error("Segment must be a LineString.");
      }
      expect(lineLength(segment.geometry.coordinates)).toBeCloseTo(30_000, 0);
    }
    expect(facilities).toHaveLength(3);
    for (const facility of facilities) {
      expect(facility.properties.facility_type).toBe("block_valve_station");
      expect(facility.properties.simulated).toBe(true);
      expect(facility.properties.label).toBe("SYNTHETIC");
    }
  });

  it("keeps the route in the Lampang–Phayao–Chiang Rai corridor", () => {
    const directory = temporaryDirectory();
    generateInto(directory);
    const route = firstFeature(readCollection(join(directory, "route.geojson")));
    if (route.geometry.type !== "LineString") {
      throw new Error("Route must be a LineString.");
    }
    const coordinates = route.geometry.coordinates;
    const checkpoints: Coordinate[] = [
      [99.49, 18.29],
      [99.9, 19.17],
      [99.77, 19.45],
    ];

    for (const checkpoint of checkpoints) {
      expect(minimumDistanceToRoute(checkpoint, coordinates)).toBeLessThan(
        25_000,
      );
    }
    for (const [longitude, latitude] of coordinates) {
      expect(latitude).toBeGreaterThanOrEqual(18);
      expect(latitude).toBeLessThanOrEqual(20);
      expect(longitude).toBeGreaterThanOrEqual(99);
      expect(longitude).toBeLessThanOrEqual(100);
    }
  });

  it("authors Bowtie A with complete paths, Triad, Evidence and the Scenario A ageing window", () => {
    const bowtie = readBowtieFixture();
    expect(bowtie.metadata).toMatchObject({
      label: "SYNTHETIC",
      simulated: true,
      classification: "CONFIDENTIAL",
    });
    expect(bowtie.threats.map(({ name }) => name)).toEqual([
      "Third-party excavation",
      "External corrosion",
      "Slope movement / river scour",
      "Overpressure",
    ]);
    expect(bowtie.consequences.map(({ name, severity }) => [name, severity])).toEqual([
      ["Jet fire near a High Consequence Area", { people: 5 }],
      ["Supply interruption", { service_continuity: 4 }],
      ["Environmental damage at a river crossing", { environment: 3 }],
    ]);
    expect(bowtie.barriers).toHaveLength(15);

    const preventiveTargets = new Set(
      bowtie.paths.filter(({ side }) => side === "preventive").map(({ targetId }) => targetId),
    );
    const mitigativeTargets = new Set(
      bowtie.paths.filter(({ side }) => side === "mitigative").map(({ targetId }) => targetId),
    );
    const usedBarrierIds = new Set(bowtie.paths.flatMap(({ barrierIds }) => barrierIds));
    for (const threat of bowtie.threats) {
      expect(preventiveTargets.has(threat.id)).toBe(true);
      expect(threat.frequencyPerYear).toBeGreaterThan(0);
    }
    for (const consequence of bowtie.consequences) {
      expect(mitigativeTargets.has(consequence.id)).toBe(true);
      expect(consequence.conditionalProbability).toBeGreaterThanOrEqual(0);
      expect(consequence.conditionalProbability).toBeLessThanOrEqual(1);
    }
    for (const barrier of bowtie.barriers) {
      expect(usedBarrierIds.has(barrier.id)).toBe(true);
      expect(barrier.performanceStandard.trim().length).toBeGreaterThan(0);
      expect(Object.values(barrier.triad).map(({ pass }) => pass)).toEqual([true, true, true]);
      expect(barrier.evidence.length).toBeGreaterThanOrEqual(2);
      expect(barrier.pfdBand).toBeGreaterThanOrEqual(barrier.type === "technical" ? 0.01 : 0.1);
    }

    const cathodicProtection = bowtie.barriers.find(({ id }) => id === "cathodic-protection");
    expect(cathodicProtection).toBeDefined();
    expect(cathodicProtection?.evidenceInterval).toBe("12 months");
    const latestEvidence = cathodicProtection?.evidence
      .map(({ observedAt }) => Date.parse(observedAt))
      .reduce((latest, observedAt) => Math.max(latest, observedAt), 0);
    const simulationStart = Date.parse(bowtie.metadata.simulationStartsAt);
    const expiry = new Date(latestEvidence ?? 0);
    expiry.setUTCFullYear(expiry.getUTCFullYear() + 1);
    expect(expiry.getTime()).toBeGreaterThan(simulationStart);
    expect(expiry.getTime()).toBeLessThanOrEqual(simulationStart + 3 * 24 * 60 * 60 * 1000);
  });

  it("binds Organisation IDs, GeoJSON and attributes outside the SQL text", () => {
    const orgId = "demo'pipeline\\'); DROP TABLE app.asset; --";
    const queries = previewSeed(orgId);
    const insertCount = (table: string) => queries.filter(({ sql }) => sql.startsWith(`insert into "app"."${table}"`)).length;
    const inserts = queries.filter(({ sql }) => sql.startsWith("insert into"));
    expect(insertCount("organisation")).toBe(1);
    expect(insertCount("asset")).toBe(4);
    expect(insertCount("segment")).toBe(6);
    expect(insertCount("bowtie")).toBe(1);
    expect(insertCount("bowtie_asset")).toBe(1);
    expect(insertCount("threat")).toBe(4);
    expect(insertCount("consequence")).toBe(3);
    expect(insertCount("barrier")).toBe(15);
    expect(insertCount("barrier_path")).toBe(21);
    expect(insertCount("independence_group")).toBe(1);
    expect(insertCount("degradation_factor")).toBe(4);
    expect(insertCount("degradation_control")).toBe(4);
    expect(insertCount("evidence")).toBe(30);
    for (const query of queries) {
      expect(query.sql).not.toContain(orgId);
      expect(query.parameters).toContain(orgId);
    }
    for (const query of inserts) {
      expect(query.sql).not.toContain(orgId);
      expect(query.sql).not.toContain("SYNTHETIC");
      expect(query.sql).not.toContain("coordinates");
      expect(query.sql).toContain("on conflict");
      expect(query.parameters).toContain(orgId);
      expect(query.parameters).toContain(true);
    }
    // PRD 9.1: Asset geometry is Highly Restricted, Bowtie and Barrier records are Confidential.
    const classOf = (table: string) => new Set(inserts
      .filter(({ sql }) => sql.startsWith(`insert into "app"."${table}"`))
      .flatMap(({ parameters }) => parameters.filter((parameter) =>
        ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED", "internal"].includes(parameter as string))));
    for (const table of ["asset", "segment"]) {
      expect([...classOf(table)]).toEqual(["HIGHLY_RESTRICTED"]);
    }
    for (const table of ["bowtie", "bowtie_asset", "threat", "consequence", "independence_group", "barrier", "barrier_path", "degradation_factor", "degradation_control", "evidence"]) {
      expect([...classOf(table)]).toEqual(["CONFIDENTIAL"]);
    }
    expect([...classOf("organisation")]).toEqual(["INTERNAL"]);
    const geometryQueries = queries.filter(({ sql }) => sql.includes("ST_GeomFromGeoJSON"));
    expect(geometryQueries).toHaveLength(10);
    for (const query of geometryQueries) {
      expect(query.sql).toContain("ST_GeomFromGeoJSON($6::text)");
      expect(JSON.parse(String(query.parameters[5]))).toHaveProperty("coordinates");
    }
    for (const query of queries.filter(({ sql }) => sql.startsWith('insert into "app"."asset"'))) {
      expect(JSON.parse(String(query.parameters[6]))).toHaveProperty("label", "SYNTHETIC");
    }
  });

  it("keeps IDs stable across reruns and distinct between Organisations", () => {
    const first = previewSeed("demo-pipeline");
    expect(previewSeed("demo-pipeline")).toEqual(first);
    const other = previewSeed("other-org");
    for (const [index, query] of first.entries()) {
      expect(other[index]?.parameters[0]).not.toBe(query.parameters[0]);
      if (index > 0 && index < 10) {
        const parentIndex = index < 4 ? 3 : 2;
        expect(query.parameters[parentIndex]).toBe(first[0]?.parameters[0]);
      }
    }
  });

  it("removes only rows this seed loaded earlier and that are no longer in the seed files", () => {
    const queries = previewSeed("demo-pipeline");
    const firstDelete = queries.findIndex(({ sql }) => sql.startsWith("delete from"));
    const deletes = queries.slice(firstDelete);
    expect(queries.slice(0, firstDelete).every(({ sql }) => sql.startsWith("insert into"))).toBe(true);
    // Children are removed before the tables they reference.
    expect(deletes.map(({ sql }) => /^delete from "app"\."([a-z_]+)"/.exec(sql)?.[1])).toEqual([
      "bowtie_asset", "evidence", "degradation_control", "degradation_factor", "barrier_path", "barrier",
      "independence_group", "consequence", "threat", "bowtie", "segment", "asset",
    ]);
    for (const query of deletes) {
      expect(query.sql).toContain('where "org_id" = $1 and "created_by" = $2 and');
      expect(query.parameters.slice(0, 2)).toEqual(["demo-pipeline", "seed:dl-01"]);
    }
    expect(queries.some(({ sql }) => sql.startsWith('delete from "app"."organisation"'))).toBe(false);
  });

  it("empties a table of this seed's rows when the seed files no longer fill it", () => {
    const result = runSeedTransaction(0, "no-degradation-factors");
    expect(result.error).toBeNull();
    const emptied = result.queries.filter(({ sql }) => /^delete from "app"\."degradation_(factor|control)"/.test(sql));
    expect(emptied.map(({ sql }) => sql)).toEqual([
      'delete from "app"."degradation_control" where "org_id" = $1 and "created_by" = $2',
      'delete from "app"."degradation_factor" where "org_id" = $1 and "created_by" = $2',
    ]);
  });

  it("executes bound queries on one connection and commits the seed", () => {
    const result = runSeedTransaction(0);
    expect(result.error).toBeNull();
    expect(result.connections).toBe(1);
    expect(result.releases).toBe(1);
    expect(result.ended).toBe(true);
    expect(result.queries).toHaveLength(previewSeed("demo'pipeline").length + 2);
    expect(result.queries[0]?.sql).toBe("begin");
    expect(result.queries.at(-1)?.sql).toBe("commit");
    expect(result.queries.slice(1, -1)).toEqual(previewSeed("demo'pipeline"));
  });

  it("rolls back and propagates an error when a seed query fails", () => {
    const result = runSeedTransaction(4);
    expect(result.error).toBe("injected seed failure");
    expect(result.connections).toBe(1);
    expect(result.releases).toBe(1);
    expect(result.ended).toBe(true);
    expect(result.queries).toHaveLength(5);
    expect(result.queries[0]?.sql).toBe("begin");
    expect(result.queries.at(-1)?.sql).toBe("rollback");
    expect(result.queries.some(({ sql }) => sql === "commit")).toBe(false);
  });

  it.each([
    ["missing-classification", "metadata.classification"],
    ["mismatched-asset", "Bowtie A seed assetCode must match the generated DL-01 Asset."],
    ["missing-threat-path", "Every Threat must have a Preventive path to the Top Event."],
    ["single-evidence", "requires an Evidence history of at least two records"],
    ["missing-segment-classification", "Feature dl-01-segment-001 requires classification."],
    ["unlabelled-facility", "Feature dl-01-bvs-001 must be labelled SYNTHETIC and simulated."],
    ["unknown-classification", "Bowtie A seed metadata classification must be one of PUBLIC, INTERNAL, CONFIDENTIAL, HIGHLY_RESTRICTED."],
  ])("rejects invalid Bowtie A data before inserting records (%s)", (mutation, expectedError) => {
    const result = runSeedTransaction(0, mutation);
    expect(result.error).toContain(expectedError);
    expect(result.connections).toBe(1);
    expect(result.queries.map(({ sql }) => sql)).toEqual(["begin", "rollback"]);
    expect(result.queries.some(({ sql }) => sql.startsWith("insert"))).toBe(false);
  });
  it.each([
    ["postgres://seeder:pw@db.example.invalid:5432/fieldloop_test", "db.example.invalid"],
    ["postgres://seeder:pw@/fieldloop_test?host=/cloudsql/project:region:instance", "/cloudsql/project:region:instance"],
    ["postgres://seeder:pw@/fieldloop_test?socket=/cloudsql/project:region:instance", "/cloudsql/project:region:instance"],
    ["postgresql://seeder:p%40w@/fieldloop_test?socket=/cloudsql/project:region:instance&sslmode=disable", "/cloudsql/project:region:instance"],
    ["postgres://seeder:pw@:5432/fieldloop_test?socket=/cloudsql/project:region:instance", "/cloudsql/project:region:instance"],
    ["postgres://seeder:pw@db.example.invalid/fieldloop_test?application_name=x@localhost/y", "db.example.invalid"],
  ])("gives the driver the host or socket directory of %s", (databaseUrl, host) => {
    expect(readDriverTarget(databaseUrl)).toEqual({ host, database: "fieldloop_test", user: "seeder" });
  });

  it.each([
    ["mysql://seeder:pw@db.example.invalid/fieldloop_test", "must use postgres:// or postgresql://"],
    ["postgres://seeder:pw@/fieldloop_test", "must include a host, database name and user"],
    ["postgres://seeder:pw@db.example.invalid/", "must include a host, database name and user"],
    ["postgres://db.example.invalid/fieldloop_test", "must include a host, database name and user"],
    ["postgres://:pw@db.example.invalid/fieldloop_test?host=/cloudsql/project:region:instance", "must include a host, database name and user"],
  ])("rejects the database URL %s", (databaseUrl, expectedError) => {
    expect(readDriverTarget(databaseUrl).error).toContain(expectedError);
  });
  it("finds no problem when one DL-01 pipeline is covered from 0 to its length", () => {
    expect(readLoadedStateProblems({ assets: 1, segments: 6, broken: 0, chainage_from: 0, chainage_to: 180000 })).toEqual([]);
  });

  it.each([
    [{ assets: 0, segments: 0, broken: 0, chainage_from: null, chainage_to: null }, ["0 DL-01 pipeline Assets instead of 1", "no Segments on the DL-01 pipeline"]],
    [{ assets: 2, segments: 6, broken: 0, chainage_from: 0, chainage_to: 180000 }, ["2 DL-01 pipeline Assets instead of 1"]],
    [{ assets: 1, segments: 5, broken: 1, chainage_from: 30000, chainage_to: 180000 }, ["Segments start at Chainage 30000 m instead of 0", "1 gaps or overlaps between Segments"]],
    [{ assets: 1, segments: 5, broken: 0, chainage_from: 0, chainage_to: 150000 }, ["Segments end at Chainage 150000 m instead of 180000"]],
    [{ assets: 1, segments: 6, broken: 2, chainage_from: 0, chainage_to: 180000 }, ["2 gaps or overlaps between Segments"]],
  ])("reports what the read-back %j does not match", (pipeline, problems) => {
    expect(readLoadedStateProblems(pipeline)).toEqual(problems);
  });
});
