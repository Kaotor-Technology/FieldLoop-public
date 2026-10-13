import type { MapFeature, MapLayerName } from "@fieldloop/map";

export type MapDomain = "all" | "pipeline-integrity" | "flood-water";

export function selectVisibleFeatures(
  layers: readonly { layer: MapLayerName; features: readonly MapFeature[] }[],
  activeLayers: readonly MapLayerName[],
  domain: MapDomain,
): MapFeature[] {
  return layers.flatMap(({ layer, features }) => activeLayers.includes(layer) ? features : [])
    .filter((feature) => domain === "all" || feature.properties.domainPack === domain);
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
