export type MapLayerName = "assets" | "barriers" | "consequences";

export type MapGeometry =
  | { type: "Point"; coordinates: [number, number] }
  | { type: "LineString"; coordinates: [number, number][] }
  | { type: "Polygon"; coordinates: [number, number][][] }
  | { type: "MultiPolygon"; coordinates: [number, number][][][] };

export interface MapFeature {
  type: "Feature";
  id: string;
  geometry: MapGeometry;
  properties: {
    name?: string | null;
    code?: string | null;
    featureKind?: string;
    classification?: string;
    simulated?: boolean;
    label?: string | null;
    health?: string | null;
    riskBand?: string | null;
    chainageFrom?: number | null;
    chainageTo?: number | null;
    evidenceObservedAt?: string | null;
    domainPack?: string | null;
    [key: string]: unknown;
  };
}

export interface MapFeatureCollection {
  type: "FeatureCollection";
  features: MapFeature[];
}

export interface MapViewport {
  latitude: number;
  longitude: number;
  zoom: number;
  heading: number;
  tilt: number;
}
