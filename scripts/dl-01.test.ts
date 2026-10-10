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

const repositoryRoot = resolve(".");
const generator = resolve("data/synthetic/dl-01/generate.mjs");
const seeder = resolve("data/synthetic/dl-01/seed.mjs");
const generatedDirectories: string[] = [];

function previewSeed(orgId: string): SeedQuery[] {
  return JSON.parse(execFileSync(
    process.execPath,
    [seeder, "--print-sql", "--org-id", orgId],
    { cwd: repositoryRoot, encoding: "utf8" },
  )) as SeedQuery[];
}

function runSeedTransaction(failAt: number): TransactionResult {
  // Exercise Kysely's PostgreSQL driver without connecting to a database.
  const script = `
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
    try {
      await loadSeed(database, buildDataset(), "demo'pipeline");
    } catch (failure) {
      error = failure.message;
    } finally {
      await database.destroy();
    }
    console.log(JSON.stringify({ queries, connections, releases, ended, error }));
  `;
  return JSON.parse(execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", script, String(failAt)],
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
    expect(route.properties.classification).toBe("internal");
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

  it("binds Organisation IDs, GeoJSON and attributes outside the SQL text", () => {
    const orgId = "demo'pipeline\\'); DROP TABLE app.asset; --";
    const queries = previewSeed(orgId);
    expect(queries).toHaveLength(10);
    expect(queries.filter(({ sql }) => sql.startsWith('insert into "app"."asset"'))).toHaveLength(4);
    expect(queries.filter(({ sql }) => sql.startsWith('insert into "app"."segment"'))).toHaveLength(6);
    for (const query of queries) {
      expect(query.sql).not.toContain(orgId);
      expect(query.sql).not.toContain("SYNTHETIC");
      expect(query.sql).not.toContain("coordinates");
      expect(query.sql).toContain("ST_GeomFromGeoJSON($6::text)");
      expect(query.sql).toContain('on conflict ("id") do update set');
      expect(query.parameters[1]).toBe(orgId);
      expect(query.parameters).toContain(true);
      expect(query.parameters).toContain("internal");
      expect(JSON.parse(String(query.parameters[5]))).toHaveProperty("coordinates");
    }
    for (const query of queries.slice(0, 4)) {
      expect(JSON.parse(String(query.parameters[6]))).toHaveProperty("label", "SYNTHETIC");
    }
  });

  it("keeps IDs stable across reruns and distinct between Organisations", () => {
    const first = previewSeed("demo-pipeline");
    expect(previewSeed("demo-pipeline")).toEqual(first);
    const other = previewSeed("other-org");
    expect(new Set(first.map(({ parameters }) => parameters[0])).size).toBe(10);
    for (const [index, query] of first.entries()) {
      expect(other[index]?.parameters[0]).not.toBe(query.parameters[0]);
      if (index > 0) {
        const parentIndex = index < 4 ? 3 : 2;
        expect(query.parameters[parentIndex]).toBe(first[0]?.parameters[0]);
      }
    }
  });

  it("executes bound queries on one connection and commits the seed", () => {
    const result = runSeedTransaction(0);
    expect(result.error).toBeNull();
    expect(result.connections).toBe(1);
    expect(result.releases).toBe(1);
    expect(result.ended).toBe(true);
    expect(result.queries).toHaveLength(12);
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
});
