import type { MapFeature, MapLayerName } from "@fieldloop/map";
import type { SimulationRun } from "./simulation-events";

export type MapDomain = "all" | "pipeline-integrity" | "flood-water";
export type BarrierMarkerStatus = "degraded" | "failed" | "unverified";
export interface MapLayerRequestState {
  layer: MapLayerName;
  isPending: boolean;
  isError: boolean;
}

const BANGKOK_STORM_SCENARIO = "bangkok-storm";
// The seventh authored event clears rain. Step can pause before it at T+7200
// after emitting accumulation, so elapsed time alone cannot determine rain state.
const BANGKOK_STORM_RAIN_END_EVENT_INDEX = 7;
const BANGKOK_STORM_RAIN_RATE_MM_PER_HOUR = 72;

export interface SimulatedRainCell {
  feature: MapFeature;
  rateMillimetersPerHour: number;
}

export function selectSimulatedRainCell(
  run: Pick<SimulationRun, "scenarioId" | "elapsedSeconds" | "nextEventIndex" | "state" | "simulated"> | null | undefined,
  assets: readonly MapFeature[],
): SimulatedRainCell | null {
  if (!run || !run.simulated || run.scenarioId !== BANGKOK_STORM_SCENARIO || run.nextEventIndex === 0 ||
      run.nextEventIndex >= BANGKOK_STORM_RAIN_END_EVENT_INDEX || run.state === "ready" || run.state === "finished") return null;

  const zone = assets.find((feature) => feature.properties.code === "Z3" &&
    feature.properties.domainPack === "flood-water" && feature.properties.featureKind === "area" &&
    feature.properties.simulated && (feature.geometry.type === "Polygon" || feature.geometry.type === "MultiPolygon"));
  return zone ? { feature: zone, rateMillimetersPerHour: BANGKOK_STORM_RAIN_RATE_MM_PER_HOUR } : null;
}

export function rainLayerVisualStyle(rateMillimetersPerHour: number) {
  const boundedRate = Math.max(0, Math.min(BANGKOK_STORM_RAIN_RATE_MM_PER_HOUR, rateMillimetersPerHour));
  const opacityStep = Math.max(1, Math.ceil((boundedRate / BANGKOK_STORM_RAIN_RATE_MM_PER_HOUR) * 5)) / 5;
  return {
    lowToken: "--color-rain-low",
    highToken: "--color-rain-high",
    colorWeight: opacityStep,
    opacity: opacityStep,
  };
}

const RISK_TOKENS = {
  intolerable: "--color-risk-intolerable",
  alarp: "--color-risk-alarp",
  acceptable: "--color-risk-acceptable",
} as const;

export function selectVisibleFeatures(
  layers: readonly { layer: MapLayerName; features: readonly MapFeature[] }[],
  activeLayers: readonly MapLayerName[],
  domain: MapDomain,
): MapFeature[] {
  return filterFeaturesByDomain(layers.flatMap(({ layer, features }) => activeLayers.includes(layer) ? features : []), domain);
}

export function mapLayerFeedback(
  requests: readonly MapLayerRequestState[],
  activeLayers: readonly MapLayerName[],
  rainOverlayVisible: boolean,
  domain: MapDomain,
  hasViewport: boolean,
) {
  const requested = hasViewport ? requests.filter(({ layer }) =>
    activeLayers.includes(layer) || (layer === "assets" && rainOverlayVisible && domain !== "pipeline-integrity"),
  ) : [];
  const isLoading = requested.some(({ isPending }) => isPending);
  const hasError = requested.some(({ isError }) => isError);
  return { isLoading, hasError, showSkeleton: isLoading || hasError };
}

export function selectMapFeature(value: unknown, setSelectedFeature: (feature: MapFeature) => void): boolean {
  if (!value || typeof value !== "object") return false;
  const feature = value as Partial<MapFeature>;
  if (feature.type !== "Feature" || typeof feature.id !== "string" || !feature.geometry || !feature.properties) return false;
  setSelectedFeature(feature as MapFeature);
  return true;
}

export function formatChainage(value: number): string {
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 }).format(value);
}

export function filterFeaturesByDomain(features: readonly MapFeature[], domain: MapDomain): MapFeature[] {
  return domain === "all" ? [...features] : features.filter((feature) => feature.properties.domainPack === domain);
}

export function summarizeVisibleFeatures(features: readonly MapFeature[]) {
  const summary = {
    riskBands: { intolerable: 0, alarp: 0, acceptable: 0 },
    barrierHealth: { healthy: 0, degraded: 0, failed: 0, unverified: 0 },
  };
  for (const feature of features) {
    const { riskBand, featureKind, health } = feature.properties;
    if (riskBand === "intolerable" || riskBand === "alarp" || riskBand === "acceptable") summary.riskBands[riskBand]++;
    if (featureKind === "barrier" && (health === "healthy" || health === "degraded" || health === "failed" || health === "unverified")) summary.barrierHealth[health]++;
  }
  return summary;
}

export function barrierMarkerStatus(health: unknown): BarrierMarkerStatus | null {
  if (health === "healthy") return null;
  if (health === "degraded" || health === "failed" || health === "unverified") return health;
  return "unverified";
}

export function selectBarrierMarkerFeatures(features: readonly MapFeature[]): MapFeature[] {
  return features.filter((feature) => barrierMarkerStatus(feature.properties.health) !== null);
}

export function riskBandVisualStyle(riskBand: unknown) {
  const normalized = typeof riskBand === "string" ? riskBand.toLowerCase() : "";
  const token = RISK_TOKENS[normalized as keyof typeof RISK_TOKENS];
  const patterned = normalized === "alarp";
  return {
    lineToken: token ?? "--color-neutral-600",
    fillToken: token ?? "--color-neutral-300",
    patterned,
    dashed: patterned,
  };
}

export function searchVisibleFeatures(features: readonly MapFeature[], query: string): MapFeature[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [...features];
  return features.filter((feature) => `${feature.properties.name ?? ""} ${feature.properties.code ?? ""} ${feature.properties.chainageFrom ?? ""} ${feature.properties.chainageTo ?? ""}`
    .toLocaleLowerCase().includes(normalizedQuery));
}

export function countVisibleBarrierAlerts(features: readonly MapFeature[]) {
  return features.reduce((counts, feature) => {
    if (feature.properties.health === "degraded") counts.degraded++;
    if (feature.properties.health === "failed") counts.failed++;
    if (feature.properties.health === "unverified") counts.unverified++;
    return counts;
  }, { degraded: 0, failed: 0, unverified: 0 });
}
