import { describe, expect, it, vi } from "vitest";
import type { MapFeature } from "@fieldloop/map";
import type { SimulationRun } from "./simulation-events";
import {
  barrierMarkerStatus,
  countVisibleBarrierAlerts,
  formatChainage,
  mapLayerFeedback,
  rainLayerVisualStyle,
  riskBandVisualStyle,
  selectSimulatedRainCell,
  searchVisibleFeatures,
  selectBarrierMarkerFeatures,
  selectMapFeature,
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
const rainZone = feature({
  id: "synthetic-zone-z3",
  name: "Demo drainage zone Z3 (SIMULATION)",
  code: "Z3",
  simulated: true,
  health: null,
  domainPack: "flood-water",
  featureKind: "area",
  geometry: { type: "Polygon", coordinates: [[[100, 13], [101, 13], [101, 14], [100, 13]]] },
});
const floodConsequence = feature({
  id: "synthetic-impact-zone",
  name: "Synthetic impact zone",
  simulated: true,
  health: null,
  domainPack: "flood-water",
  featureKind: "consequence",
  geometry: { type: "Polygon", coordinates: [[[100, 13], [101, 13], [101, 14], [100, 13]]] },
});
const bangkokStormRun: SimulationRun = {
  id: "11111111-1111-4111-8111-111111111111",
  revision: 1,
  orgId: "test-org",
  scenarioId: "bangkok-storm",
  scenarioName: "Bangkok storm",
  seed: 42,
  speed: 1,
  clock: "2026-10-12T00:00:00Z",
  elapsedSeconds: 0,
  durationSeconds: 259_200,
  state: "playing",
  nextEventIndex: 3,
  eventCount: 13,
  simulated: true,
  classification: "CONFIDENTIAL",
  bookmarks: [],
};

describe("map visible feature state", () => {
  it("projects the active Bangkok Scenario rain event onto simulated zone Z3", () => {
    expect(selectSimulatedRainCell(bangkokStormRun, [rainZone])).toEqual({
      feature: rainZone,
      rateMillimetersPerHour: 72,
    });
    expect(selectSimulatedRainCell({ ...bangkokStormRun, elapsedSeconds: 7_199 }, [rainZone])).not.toBeNull();
    expect(selectSimulatedRainCell({ ...bangkokStormRun, elapsedSeconds: 7_200, nextEventIndex: 8 }, [rainZone])).toBeNull();
  });

  it("waits for the simulator to emit the initial rain event and requires simulated flood-zone geometry", () => {
    expect(selectSimulatedRainCell({ ...bangkokStormRun, state: "ready", nextEventIndex: 0 }, [rainZone])).toBeNull();
    expect(selectSimulatedRainCell({ ...bangkokStormRun, scenarioId: "cp-rectifier-failure" }, [rainZone])).toBeNull();
    expect(selectSimulatedRainCell(bangkokStormRun, [simulatedAsset])).toBeNull();
  });

  it("uses DESIGN rain tokens with opacity in 0.2 steps", () => {
    expect(rainLayerVisualStyle(0)).toEqual({
      lowToken: "--color-rain-low", highToken: "--color-rain-high", colorWeight: 0.2, opacity: 0.2,
    });
    expect(rainLayerVisualStyle(36).opacity).toBe(0.6);
    expect(rainLayerVisualStyle(72)).toEqual({
      lowToken: "--color-rain-low", highToken: "--color-rain-high", colorWeight: 1, opacity: 1,
    });
  });

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

  it("keeps Healthy Barriers in the keyboard feature list while excluding them from map markers", () => {
    const visible = selectVisibleFeatures([
      { layer: "barriers", features: [healthyBarrier, failedBarrier] },
    ], ["barriers"], "all");

    expect(visible).toContain(healthyBarrier);
    expect(selectBarrierMarkerFeatures(visible)).not.toContain(healthyBarrier);
  });

  it("shows Consequence features when their map layer and Domain are active", () => {
    expect(selectVisibleFeatures([
      { layer: "consequences", features: [floodConsequence] },
    ], ["consequences"], "flood-water")).toEqual([floodConsequence]);
  });

  it("selects a valid map feature for the Overview panel and formats Chainage in mono-friendly groups", () => {
    const setSelectedFeature = vi.fn();

    expect(selectMapFeature(segment, setSelectedFeature)).toBe(true);
    expect(setSelectedFeature).toHaveBeenCalledWith(segment);
    expect(selectMapFeature({ type: "Feature", id: null }, setSelectedFeature)).toBe(false);
    expect(formatChainage(segment.properties.chainageFrom ?? 0)).toBe("1,200");
  });

  it("shows a skeleton while requested map layers load and on their inline-error state", () => {
    const requests = [
      { layer: "assets" as const, isPending: true, isError: false },
      { layer: "barriers" as const, isPending: false, isError: false },
      { layer: "consequences" as const, isPending: false, isError: false },
    ];

    expect(mapLayerFeedback(requests, ["assets"], false, "all", true)).toEqual({
      isLoading: true, hasError: false, showSkeleton: true,
    });
    expect(mapLayerFeedback([
      { layer: "assets", isPending: false, isError: false },
      { layer: "barriers", isPending: false, isError: true },
      { layer: "consequences", isPending: false, isError: false },
    ], ["barriers"], false, "all", true)).toEqual({
      isLoading: false, hasError: true, showSkeleton: true,
    });
    expect(mapLayerFeedback([
      { layer: "assets", isPending: false, isError: false },
      { layer: "barriers", isPending: false, isError: true },
      { layer: "consequences", isPending: false, isError: false },
    ], ["assets"], false, "all", true)).toEqual({
      isLoading: false, hasError: false, showSkeleton: false,
    });
    expect(mapLayerFeedback([
      { layer: "assets", isPending: true, isError: false },
      { layer: "barriers", isPending: false, isError: false },
      { layer: "consequences", isPending: false, isError: false },
    ], [], true, "flood-water", true)).toEqual({
      isLoading: true, hasError: false, showSkeleton: true,
    });
    expect(mapLayerFeedback(requests, ["assets"], false, "all", false)).toEqual({
      isLoading: false, hasError: false, showSkeleton: false,
    });
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
  code?: string;
  simulated: boolean;
  health: "healthy" | "degraded" | "failed" | "unverified" | null;
  featureKind?: MapFeature["properties"]["featureKind"];
  geometry?: MapFeature["geometry"];
  riskBand?: MapFeature["properties"]["riskBand"];
  domainPack?: "pipeline-integrity" | "flood-water";
}): MapFeature {
  return {
    type: "Feature",
    id: input.id,
    geometry: input.geometry ?? { type: "Point", coordinates: [100, 14] },
    properties: {
      name: input.name,
      code: input.code ?? null,
      featureKind: input.featureKind ?? (input.health ? "barrier" : "facility"),
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
