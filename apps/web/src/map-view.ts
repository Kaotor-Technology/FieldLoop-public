import type { MapFeature, MapLayerName } from "@fieldloop/map";

export type MapDomain = "all" | "pipeline-integrity" | "flood-water";
export type BarrierMarkerStatus = "degraded" | "failed" | "unverified";

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
