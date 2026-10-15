import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseKml } from "../apps/api/src/imports/parser.js";
// @ts-expect-error The generator is plain ESM without type declarations.
import { buildEncroachmentFixtures } from "../data/synthetic/dl-01/encroachment-kml.mjs";

const DATA = new URL("../data/synthetic/dl-01/", import.meta.url);
const EARTH_RADIUS_M = 6_371_008.8;
type Coordinate = [number, number];

const radians = (degrees: number) => (degrees * Math.PI) / 180;
// Distance from a point to a route leg on a local plane; legs are about 1 km long.
function distanceToLeg(point: Coordinate, start: Coordinate, end: Coordinate): number {
  const scale = Math.cos(radians(point[1]));
  const toMetres = (coordinate: Coordinate): Coordinate => [
    radians(coordinate[0]) * scale * EARTH_RADIUS_M,
    radians(coordinate[1]) * EARTH_RADIUS_M,
  ];
  const [p, a, b] = [toMetres(point), toMetres(start), toMetres(end)];
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const squared = dx * dx + dy * dy; // The synthetic route repeats one vertex.
  const t = squared === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / squared));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
function distanceToRoute(point: Coordinate, route: Coordinate[]): number {
  return Math.min(...route.slice(1).map((end, index) => distanceToLeg(point, route[index] as Coordinate, end)));
}

const route = (
  JSON.parse(readFileSync(new URL("route.geojson", DATA), "utf8")) as {
    features: { geometry: { coordinates: Coordinate[] } }[];
  }
).features[0]?.geometry.coordinates as Coordinate[];

describe("synthetic DL-01 encroachment KML fixtures (FL-48)", () => {
  it("matches the committed files, so regeneration is deterministic", async () => {
    for (const [name, content] of Object.entries(await buildEncroachmentFixtures() as Record<string, string>)) {
      expect(readFileSync(new URL(name, DATA), "utf8"), name).toBe(content);
    }
  });

  it("holds 10 points inside the 50 m snap tolerance and parses them safely", () => {
    const points = parseKml(readFileSync(new URL("encroachment-points.kml", DATA), "utf8"));
    expect(points).toHaveLength(10);
    for (const point of points) {
      const distance = distanceToRoute([point.longitude, point.latitude], route);
      expect(distance).toBeGreaterThan(5);
      expect(distance).toBeLessThan(40);
      expect(point.attributes["folder"]).toBe("Right-of-Way patrol (SYNTHETIC)");
      expect(point.attributes["ExtendedData.category"]).toBeTruthy();
    }
  });

  it("holds one point about 80 m from the route", () => {
    const points = parseKml(readFileSync(new URL("encroachment-outside-tolerance.kml", DATA), "utf8"));
    expect(points).toHaveLength(1);
    const point = points[0] as { longitude: number; latitude: number };
    expect(distanceToRoute([point.longitude, point.latitude], route)).toBeCloseTo(80, 0);
  });
});
