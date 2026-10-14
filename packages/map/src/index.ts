import type { components } from "@fieldloop/contracts";

export type MapLayerName = "assets" | "barriers" | "consequences" | "geo-references";
export type MapGeometry = components["schemas"]["MapGeometry"];
export type MapFeature = components["schemas"]["MapFeature"];
export type MapFeatureProperties = components["schemas"]["MapFeatureProperties"];
export type MapFeatureCollection = components["schemas"]["MapFeatureCollection"];

export interface MapViewport {
  latitude: number;
  longitude: number;
  zoom: number;
  heading: number;
  tilt: number;
}
