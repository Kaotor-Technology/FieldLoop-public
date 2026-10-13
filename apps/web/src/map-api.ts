import type { MapFeatureCollection, MapLayerName } from "@fieldloop/map";
import createClient from "openapi-fetch";
import type { paths } from "@fieldloop/contracts";

const client = createClient<paths>({ baseUrl: "/api", credentials: "same-origin" });

interface MapConfig {
  mapsApiKey: string;
}

export async function getMapConfig(signal: AbortSignal): Promise<MapConfig> {
  const { data, error } = await client.GET("/v1/map/config", { signal });
  if (error || !data) throw new Error("Map configuration is unavailable");
  return data;
}

export async function getMapLayer(input: {
  layer: MapLayerName;
  bbox: readonly [number, number, number, number];
  zoom: number;
  signal: AbortSignal;
}): Promise<MapFeatureCollection> {
  const { data, error } = await client.GET("/v1/map/layers/{layer}", {
    params: { path: { layer: input.layer }, query: { bbox: [...input.bbox], zoom: input.zoom } },
    signal: input.signal,
  });
  if (error || !data) throw new Error("Map layers are unavailable for this Organisation or clearance");
  return data;
}
