import type { StripBandData } from "../src/strip-band-data";

// Independent PUBLIC synthetic fixture, not DL-01 and not copied from Stitch metrics.
export const stripBandFixture: StripBandData = {
  schemaVersion: 1, assetCode: "SYNTHETIC-FIXTURE", lengthM: 100,
  classification: "PUBLIC", simulated: true, label: "SYNTHETIC",
  segments: [
    { id: "fixture-short", name: "Fixture short Segment", chainageFromM: 0, chainageToM: 25 },
    { id: "fixture-long", name: "Fixture long Segment", chainageFromM: 25, chainageToM: 100 },
  ],
  facilities: [{ id: "fixture-facility", name: "Fixture Facility", chainageM: 25 }],
  barriers: ["healthy", "degraded", "failed", "unverified"].map((health, index) => ({
    id: `fixture-${index}`, name: `Fixture Barrier ${index}`, health: health as "healthy" | "degraded" | "failed" | "unverified", chainageM: null,
  })),
  inspections: [], threatCategories: [],
};
