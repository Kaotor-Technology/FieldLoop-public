import type { MapFeatureCollection, MapLayerName } from "@fieldloop/map";

interface MapConfig {
  mapsApiKey: string;
}

export async function getMapConfig(signal: AbortSignal): Promise<MapConfig> {
  const response = await fetch("/api/v1/map/config", { credentials: "same-origin", cache: "no-store", signal });
  if (!response.ok) throw new Error("Map configuration is unavailable");
  return await response.json() as MapConfig;
}

export async function getMapLayer(input: {
  layer: MapLayerName;
  bbox: readonly [number, number, number, number];
  zoom: number;
  signal: AbortSignal;
}): Promise<MapFeatureCollection> {
  const query = new URLSearchParams({ bbox: input.bbox.join(","), zoom: String(input.zoom) });
  const response = await fetch(`/api/v1/map/layers/${input.layer}?${query}`, {
    credentials: "same-origin", cache: "no-store", signal: input.signal,
    headers: { Accept: "application/geo+json" },
  });
  if (!response.ok) throw new Error("Map layers are unavailable for this Organisation or clearance");
  return await response.json() as MapFeatureCollection;
}
