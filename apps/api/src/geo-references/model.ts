export type GeoReferenceKind = "point" | "chainage" | "area" | "asset";
export type GeoReferenceDecision = "confirm" | "reject";

export interface GeoScope {
  sub: string;
  orgId: string;
  clearance: string;
}

export interface AssistantGeoIdentity extends GeoScope {
  roles: string[];
}

export interface GeoReferenceCandidate {
  latitude: number | null;
  longitude: number | null;
  chainageFrom: number | null;
  chainageTo: number | null;
  assetCode: string | null;
  placeName: string | null;
  sourceSnippet: string;
  confidence: number;
}

export interface GeoSourceDocument {
  id: string;
  title: string;
  folder: string | null;
  text: string;
  simulated: boolean;
  classification: string;
}

export interface GeoReferenceItem {
  id: string;
  documentId: string;
  documentTitle: string;
  kind: GeoReferenceKind;
  geometry: { type: "Point" | "LineString" | "Polygon" | "MultiPolygon"; coordinates: unknown } | null;
  chainageFrom: number | null;
  chainageTo: number | null;
  proposedLabel: string | null;
  sourceSnippet: string;
  confidence: number;
  targetAssetId: string | null;
  status: "draft" | "confirmed" | "rejected";
  simulated: boolean;
  classification: string;
  createdAt: string;
}

export interface GeoReferencePage {
  items: GeoReferenceItem[];
  limit: number;
  nextCursor: string | null;
}

export interface GeoReferenceCreateResult {
  references: GeoReferenceItem[];
  replayed: boolean;
}

export interface GeoReferenceStore {
  getSource(documentId: string, scope: GeoScope): Promise<GeoSourceDocument>;
  createDrafts(input: {
    documentId: string;
    scope: AssistantGeoIdentity;
    idempotencyKey: string;
    references: GeoReferenceCandidate[];
  }): Promise<GeoReferenceCreateResult>;
  listDrafts(scope: GeoScope, cursor: string | undefined, limit: number): Promise<GeoReferencePage>;
  decide(input: {
    scope: GeoScope;
    geoReferenceId: string;
    decision: GeoReferenceDecision;
    targetAssetId?: string;
    idempotencyKey: string;
  }): Promise<GeoReferenceItem>;
}

export class GeoReferenceServiceError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 503,
    readonly code: string,
  ) {
    super(code);
    this.name = "GeoReferenceServiceError";
  }
}
