import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The committed DL-01 source is synthetic; never print its protected positions.
const source = {
  route: JSON.parse(readFileSync("data/synthetic/dl-01/route.geojson", "utf8")),
  segments: JSON.parse(readFileSync("data/synthetic/dl-01/segments.geojson", "utf8")),
  facilities: JSON.parse(readFileSync("data/synthetic/dl-01/facilities.geojson", "utf8")),
  bowtie: JSON.parse(readFileSync("data/synthetic/dl-01/bowtie-a.json", "utf8")),
};
async function generator() {
  const path = "../data/synthetic/dl-01/strip-band.mjs";
  return import(path).catch(() => ({}));
}
describe("static strip seed projection", () => {
  it("derives ordered Segment extents from the actual seed without geometry", async () => {
    const module = await generator();
    expect(module.buildStripBand, "static band generator is required").toBeTypeOf("function");
    const band = module.buildStripBand(source);
    expect(band.assetCode).toBe(source.route.features[0].properties.asset_code);
    expect(band.lengthM).toBe(source.route.features[0].properties.length_m);
    expect(band.classification).toBe("HIGHLY_RESTRICTED");
    expect(band.simulated).toBe(true);
    expect(band.segments).toEqual(source.segments.features.map((feature: typeof source.segments.features[number]) => ({
      id: feature.id, name: feature.properties.name,
      chainageFromM: feature.properties.chainage_from_m,
      chainageToM: feature.properties.chainage_to_m,
    })));
    expect(JSON.stringify(band)).not.toContain("coordinates");
  });
  it("keeps seed Barriers unlocated instead of inventing Chainage or treating Facilities as Barriers", async () => {
    const band = (await generator()).buildStripBand(source);
    expect(band.barriers).toEqual(source.bowtie.barriers.map((barrier: typeof source.bowtie.barriers[number]) => ({
      id: barrier.id, name: barrier.name, health: barrier.health, chainageM: null,
    })));
    expect(band.facilities).toEqual(source.facilities.features.map((feature: typeof source.facilities.features[number]) => ({
      id: feature.id, name: feature.properties.name, chainageM: feature.properties.chainage_m,
    })));
    expect(band.inspections).toEqual([]);
    expect(band.threatCategories).toEqual([]);
  });
  it("fails closed on broken Segment coverage, mismatched Asset, non-synthetic or missing classification", async () => {
    const { buildStripBand } = await generator();
    for (const mutate of [
      (s: typeof source) => { s.segments.features[1].properties.chainage_from_m += 1; },
      (s: typeof source) => { s.segments.features[0].properties.chainage_to_m = NaN; },
      (s: typeof source) => { s.bowtie.assetCode = "wrong-asset"; },
      (s: typeof source) => { s.route.features[0].properties.simulated = false; },
      (s: typeof source) => { delete s.facilities.features[0].properties.classification; },
      (s: typeof source) => { s.facilities.features[0].properties.chainage_m = -1; },
    ]) {
      const changed = structuredClone(source); mutate(changed);
      expect(() => buildStripBand(changed)).toThrow();
    }
  });
  it("serializes deterministically and detects stale generated data without overwriting it", async () => {
    const { buildStripBand, serializeStripBand, checkStripBand } = await generator();
    expect(serializeStripBand, "deterministic serialization is required").toBeTypeOf("function");
    const expected = serializeStripBand(buildStripBand(source));
    expect(expected).toBe(serializeStripBand(buildStripBand(structuredClone(source))));
    const directory = mkdtempSync(join(tmpdir(), "fl93-synthetic-"));
    const file = join(directory, "strip-band.json");
    try {
      writeFileSync(file, expected);
      expect(checkStripBand(file, source)).toBe(true);
      writeFileSync(file, "{}\n");
      expect(() => checkStripBand(file, source)).toThrow(/stale/i);
      expect(readFileSync(file, "utf8")).toBe("{}\n");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("retains the highest contributing classification without inventing source metadata", async () => {
    const changed = structuredClone(source);
    changed.route.features[0].properties.classification = "PUBLIC";
    const band = (await generator()).buildStripBand(changed);
    expect(band.classification).toBe("HIGHLY_RESTRICTED");
  });
  it("requires the committed generated file to match the current seed", async () => {
    const { readStripSource, checkStripBand } = await generator();
    expect(readStripSource()).toEqual(source);
    expect(checkStripBand("data/synthetic/dl-01/strip-band.json", readStripSource())).toBe(true);
  });
});
