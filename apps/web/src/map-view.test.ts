import { describe, expect, it } from "vitest";
import type { MapFeature } from "@fieldloop/map";
import {
  barrierMarkerStatus,
  countVisibleBarrierAlerts,
  riskBandVisualStyle,
  searchVisibleFeatures,
  selectBarrierMarkerFeatures,
  selectVisibleFeatures,
  summarizeVisibleFeatures,
} from "./map-view.js";

const simulatedAsset = feature({ id: "synthetic-asset", name: "DL-01", simulated: true, health: null });
const failedBarrier = feature({ id: "failed-barrier", name: "Valve barrier", simulated: true, health: "failed" });
const healthyBarrier = feature({ id: "healthy-barrier", name: "Healthy barrier", simulated: true, health: "healthy" });
const segment: MapFeature = {
  ...simulatedAsset,
  id: "pipeline-segment",
  properties: { ...simulatedAsset.properties, featureKind: "segment", chainageFrom: 1200, chainageTo: 1400 },
};

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

  it("finds a Segment by its Chainage range", () => {
    expect(searchVisibleFeatures([segment], "1400")).toEqual([segment]);
  });

  it("summarizes only visible feature Risk Matrix bands and Barrier Health", () => {
    const visible = selectVisibleFeatures([
      { layer: "assets", features: [
        feature({ id: "intolerable", name: "A", simulated: true, health: null, riskBand: "intolerable" }),
        feature({ id: "alarp", name: "B", simulated: true, health: null, riskBand: "alarp" }),
        feature({ id: "acceptable", name: "C", simulated: true, health: null, riskBand: "acceptable" }),
        feature({ id: "outside-domain", name: "D", simulated: true, health: null, riskBand: "intolerable", domainPack: "flood-water" }),
      ] },
      { layer: "barriers", features: [
        healthyBarrier,
        feature({ id: "degraded", name: "E", simulated: true, health: "degraded" }),
        failedBarrier,
        feature({ id: "unverified", name: "F", simulated: true, health: "unverified" }),
      ] },
    ], ["assets", "barriers"], "pipeline-integrity");

    expect(summarizeVisibleFeatures(visible)).toEqual({
      riskBands: { intolerable: 1, alarp: 1, acceptable: 1 },
      barrierHealth: { healthy: 1, degraded: 1, failed: 1, unverified: 1 },
    });
  });

  it("excludes Healthy Barriers from map markers and maps other Health to a known icon", () => {
    const markers = selectBarrierMarkerFeatures([healthyBarrier, failedBarrier]);
    expect(markers.map(({ id }) => id)).toEqual(["failed-barrier"]);
    expect(barrierMarkerStatus("degraded")).toBe("degraded");
    expect(barrierMarkerStatus("failed")).toBe("failed");
    expect(barrierMarkerStatus("unverified")).toBe("unverified");
    expect(barrierMarkerStatus("healthy")).toBeNull();
    expect(barrierMarkerStatus(null)).toBe("unverified");
  });

  it("maps Risk Matrix bands to DESIGN tokens and gives ALARP both non-colour cues", () => {
    expect(riskBandVisualStyle("intolerable")).toEqual({
      lineToken: "--color-risk-intolerable", fillToken: "--color-risk-intolerable", patterned: false, dashed: false,
    });
    expect(riskBandVisualStyle("ALARP")).toEqual({
      lineToken: "--color-risk-alarp", fillToken: "--color-risk-alarp", patterned: true, dashed: true,
    });
    expect(riskBandVisualStyle("acceptable")).toEqual({
      lineToken: "--color-risk-acceptable", fillToken: "--color-risk-acceptable", patterned: false, dashed: false,
    });
    expect(riskBandVisualStyle(null)).toEqual({
      lineToken: "--color-neutral-600", fillToken: "--color-neutral-300", patterned: false, dashed: false,
    });
  });
});

function feature(input: {
  id: string;
  name: string;
  simulated: boolean;
  health: "healthy" | "degraded" | "failed" | "unverified" | null;
  riskBand?: MapFeature["properties"]["riskBand"];
  domainPack?: "pipeline-integrity" | "flood-water";
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
      riskBand: input.riskBand ?? null,
      chainageFrom: null,
      chainageTo: null,
      evidenceObservedAt: null,
      domainPack: input.domainPack ?? "pipeline-integrity",
    },
  };
}
