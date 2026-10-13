import { describe, expect, it } from "vitest";

// Independent PUBLIC synthetic fixture; never loads the classified DL-01 seed.
function source() {
  const metadata = { label: "SYNTHETIC", simulated: true, classification: "PUBLIC" };
  return {
    route: { features: [{ properties: { ...metadata, asset_code: "TEST-STRIP", length_m: 100 } }] },
    segments: { features: [{ id: "test-segment", properties: { ...metadata, name: "Test Segment", chainage_from_m: 0, chainage_to_m: 100 } }] },
    facilities: { features: [{ id: "test-facility", properties: { ...metadata, name: "Test Facility", chainage_m: 50 } }] },
    bowtie: { assetCode: "TEST-STRIP", metadata, barriers: [{ id: "test-barrier", name: "Test Barrier", health: "healthy" }] },
  };
}
async function build() {
  const path = "../data/synthetic/dl-01/strip-band.mjs";
  return (await import(path)).buildStripBand;
}
describe("strip output boundary validation", () => {
  describe.each(["Asset", "Segment", "Facility", "Barrier"] as const)("%s identifier", (kind) => {
    it.each([undefined, null, "", " \t\n", 1, {}])("rejects missing or non-string identifier %s", async (id) => {
      const input = source();
      if (kind === "Asset") {
        Object.assign(input.route.features[0]?.properties ?? {}, { asset_code: id });
        Object.assign(input.bowtie, { assetCode: id });
      } else {
        const record = kind === "Segment" ? input.segments.features[0]
          : kind === "Facility" ? input.facilities.features[0] : input.bowtie.barriers[0];
        if (!record) throw new Error("Test fixture requires a record.");
        Object.assign(record, { id });
      }
      const buildStripBand = await build();
      expect(() => buildStripBand(input)).toThrow(/identifier/);
    });
  });
  describe.each(["Segment", "Facility", "Barrier"] as const)("%s name", (kind) => {
    it.each([undefined, null, "", " \t\n", 1, {}])("rejects missing or non-string name %s", async (name) => {
      const input = source();
      const record = kind === "Segment" ? input.segments.features[0]?.properties
        : kind === "Facility" ? input.facilities.features[0]?.properties : input.bowtie.barriers[0];
      if (!record) throw new Error("Test fixture requires a named record.");
      Object.assign(record, { name });
      const buildStripBand = await build();
      expect(() => buildStripBand(input)).toThrow(/name/);
    });
  });
  it.each([undefined, null, "", "unknown", "Healthy", 1])("rejects invalid Barrier Health %s", async (health) => {
    const input = source();
    const barrier = input.bowtie.barriers[0];
    if (!barrier) throw new Error("Test fixture requires a Barrier.");
    Object.assign(barrier, { health });
    const buildStripBand = await build();
    expect(() => buildStripBand(input)).toThrow(/Health/);
  });
  it.each(["healthy", "degraded", "failed", "unverified"])("preserves valid Barrier Health %s", async (health) => {
    const input = source();
    const barrier = input.bowtie.barriers[0];
    if (!barrier) throw new Error("Test fixture requires a Barrier.");
    barrier.health = health;
    expect((await build())(input).barriers[0].health).toBe(health);
  });
});
