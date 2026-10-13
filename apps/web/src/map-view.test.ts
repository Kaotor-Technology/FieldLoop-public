import { describe, expect, it } from "vitest";
import type { MapFeature } from "@fieldloop/map";
import { countVisibleBarrierAlerts, searchVisibleFeatures, selectVisibleFeatures } from "./map-view.js";

const simulatedAsset = feature({ id: "synthetic-asset", name: "DL-01", simulated: true, health: null });
const failedBarrier = feature({ id: "failed-barrier", name: "Valve barrier", simulated: true, health: "failed" });

describe("map visible feature state", () => {
  it("keeps simulated provenance tied to rendered geometry when search has no matches", () => {
    const rendered = selectVisibleFeatures([
      { layer: "assets", features: [simulatedAsset] },
      { layer: "barriers", features: [failedBarrier] },
      { layer: "consequences", features: [] },
    ], ["assets", "barriers", "consequences"], "all");
    expect(searchVisibleFeatures(rendered, "no matching feature")).toEqual([]);
    expect(rendered.some((item) => item.properties.simulated)).toBe(true);
  });

  it("excludes disabled layers from features and alert counts while search does not change alert totals", () => {
    const rendered = selectVisibleFeatures([
      { layer: "assets", features: [simulatedAsset] },
      { layer: "barriers", features: [failedBarrier] },
      { layer: "consequences", features: [] },
    ], ["assets"], "all");
    expect(rendered.map((item) => item.id)).toEqual(["synthetic-asset"]);
    expect(countVisibleBarrierAlerts(rendered)).toEqual({ degraded: 0, failed: 0, unverified: 0 });
    expect(searchVisibleFeatures(rendered, "valve")).toEqual([]);
  });
});

function feature(input: {
  id: string;
  name: string;
  simulated: boolean;
  health: "failed" | null;
}): MapFeature {
  return {
    type: "Feature",
    id: input.id,
    geometry: { type: "Point", coordinates: [100, 14] },
    properties: {
      name: input.name,
      code: null,
      featureKind: input.health ? "barrier" : "facility",
      classification: "HIGHLY_RESTRICTED",
      simulated: input.simulated,
      label: null,
      health: input.health,
      riskBand: null,
      chainageFrom: null,
      chainageTo: null,
      evidenceObservedAt: null,
      domainPack: "pipeline-integrity",
    },
  };
}
