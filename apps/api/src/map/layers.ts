import type { FastifyInstance, FastifyRequest } from "fastify";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { MapFeature, MapFeatureCollection, MapGeometry, MapLayerName } from "@fieldloop/map";
import type { AuthDatabase } from "../auth/postgres-store.js";

export type MapBoundingBox = readonly [west: number, south: number, east: number, north: number];
export type { MapFeature, MapFeatureCollection, MapLayerName } from "@fieldloop/map";

export interface MapLayerStore {
  getLayer(input: {
    layer: MapLayerName;
    bbox: MapBoundingBox;
    zoom: number;
    orgId: string;
    clearance: string;
    allowSeededDemoGeometry: boolean;
  }): Promise<MapFeatureCollection>;
}

const CLASSIFICATION_ORDER = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED"] as const;
const DEMO_ROLES = new Set(["fieldloop.viewer", "fieldloop.operator", "fieldloop.manager"]);
const MAX_FEATURES = 50_000;

export class UnavailableMapLayerStore implements MapLayerStore {
  async getLayer(): Promise<MapFeatureCollection> {
    throw new MapServiceError("service_unavailable", 503, "Map data is unavailable");
  }
}

export class PostgresMapLayerStore implements MapLayerStore {
  constructor(private readonly db: Kysely<AuthDatabase>) {}

  async getLayer(input: {
    layer: MapLayerName;
    bbox: MapBoundingBox;
    zoom: number;
    orgId: string;
    clearance: string;
    allowSeededDemoGeometry: boolean;
  }): Promise<MapFeatureCollection> {
    const visibleClassifications = classificationsThrough(input.clearance);
    const [west, south, east, north] = input.bbox;
    const bboxValues = [west, south, east, north, input.orgId, visibleClassifications,
      featureLimitForZoom(input.zoom), input.allowSeededDemoGeometry];

    const result = input.layer === "assets"
      ? await bindPostgisQuery<FeatureRow>(ASSET_LAYER_SQL, bboxValues).execute(this.db)
      : input.layer === "barriers"
        ? await bindPostgisQuery<FeatureRow>(BARRIER_LAYER_SQL, bboxValues).execute(this.db)
        : await bindPostgisQuery<FeatureRow>(CONSEQUENCE_LAYER_SQL, bboxValues).execute(this.db);

    return {
      type: "FeatureCollection",
      features: result.rows.map((row) => ({
        type: "Feature",
        id: row.id,
        geometry: parseMapGeometry(row.geometry),
        properties: {
          name: row.name,
          code: row.code,
          featureKind: parseFeatureKind(row.feature_kind),
          classification: row.classification,
          simulated: row.simulated,
          label: row.label,
          health: parseHealth(row.health),
          riskBand: parseRiskBand(row.risk_band),
          chainageFrom: row.chainage_from === null ? null : Number(row.chainage_from),
          chainageTo: row.chainage_to === null ? null : Number(row.chainage_to),
          evidenceObservedAt: row.evidence_observed_at,
          domainPack: row.domain_pack,
        },
      })),
    };
  }
}

function bindPostgisQuery<Row>(queryText: string, values: readonly unknown[]) {
  const parts = queryText.split(/(\$\d+)/g);
  let query = sql<Row>`${sql.raw(parts[0] ?? "")}`;
  for (let index = 1; index < parts.length; index += 2) {
    const placeholder = parts[index];
    if (!placeholder) continue;
    const valueIndex = Number(placeholder.slice(1)) - 1;
    if (!Number.isInteger(valueIndex) || valueIndex < 0 || valueIndex >= values.length) {
      throw new Error(`Invalid PostGIS query placeholder: ${placeholder}`);
    }
    query = sql<Row>`${query}${values[valueIndex]}${sql.raw(parts[index + 1] ?? "")}`;
  }
  return query;
}

interface FeatureRow {
  id: string;
  geometry: string | Record<string, unknown>;
  name: string | null;
  code: string | null;
  feature_kind: string;
  classification: string;
  simulated: boolean;
  label: string | null;
  health: string | null;
  risk_band: string | null;
  chainage_from: number | null;
  chainage_to: number | null;
  evidence_observed_at: string | null;
  domain_pack: string | null;
}

export class MapServiceError extends Error {
  constructor(readonly code: "validation_failed" | "service_unavailable", readonly statusCode: 400 | 503, message: string) {
    super(message);
  }
}

export function registerMapLayerRoutes(app: FastifyInstance, store: MapLayerStore, mapsApiKey?: string): void {
  app.get("/api/v1/map/config", async (_request, reply) => {
    if (!mapsApiKey) {
      return reply.code(503).type("application/problem+json").send({
        type: "about:blank", title: "Map configuration is unavailable", status: 503,
        code: "service_unavailable", traceId: _request.id,
      });
    }
    return reply.header("cache-control", "private, no-store").send({ mapsApiKey });
  });

  app.get("/api/v1/map/layers/:layer", async (request, reply) => {
    const user = request.fieldLoopCurrentUser;
    if (!user) {
      return reply.code(401).type("application/problem+json").send({
        type: "about:blank", title: "Authentication required", status: 401,
        code: "unauthenticated", traceId: request.id,
      });
    }

    try {
      const input = parseMapLayerRequest(request);
      const collection = await store.getLayer({
        ...input,
        orgId: user.orgId,
        clearance: user.clearance,
        allowSeededDemoGeometry: user.roles.some((role) => DEMO_ROLES.has(role)),
      });
      return reply.header("cache-control", "private, no-store").type("application/geo+json").send(collection);
    } catch (error) {
      if (error instanceof MapServiceError) {
        return reply.code(error.statusCode).type("application/problem+json").send({
          type: "about:blank", title: error.message, status: error.statusCode,
          code: error.code, traceId: request.id,
        });
      }
      request.log.error({ err: error }, "Map layer query failed");
      return reply.code(503).type("application/problem+json").send({
        type: "about:blank", title: "Map data is unavailable", status: 503,
        code: "service_unavailable", traceId: request.id,
      });
    }
  });
}

function parseMapLayerRequest(request: FastifyRequest): {
  layer: MapLayerName;
  bbox: MapBoundingBox;
  zoom: number;
} {
  const params = request.params as { layer?: unknown };
  const query = request.query as { bbox?: unknown; zoom?: unknown };
  if (params.layer !== "assets" && params.layer !== "barriers" && params.layer !== "consequences") {
    throw new MapServiceError("validation_failed", 400, "Layer must be assets, barriers or consequences");
  }
  const bboxParts = typeof query.bbox === "string" ? query.bbox.split(",").map(Number) : [];
  if (bboxParts.length !== 4 || bboxParts.some((value) => !Number.isFinite(value))) {
    throw new MapServiceError("validation_failed", 400, "bbox must contain west,south,east,north coordinates");
  }
  const [west, south, east, north] = bboxParts;
  if (west === undefined || south === undefined || east === undefined || north === undefined ||
      west < -180 || east > 180 || west >= east || south < -90 || north > 90 || south >= north) {
    throw new MapServiceError("validation_failed", 400, "bbox coordinates are outside valid geographic bounds");
  }
  const zoom = typeof query.zoom === "string" ? Number(query.zoom) : Number.NaN;
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > 22) {
    throw new MapServiceError("validation_failed", 400, "zoom must be an integer from 0 through 22");
  }
  return { layer: params.layer, bbox: [west, south, east, north], zoom };
}

function classificationsThrough(clearance: string): string[] {
  const normalized = clearance.trim().toUpperCase();
  const index = CLASSIFICATION_ORDER.indexOf(normalized as (typeof CLASSIFICATION_ORDER)[number]);
  if (index < 0) return [];
  return CLASSIFICATION_ORDER.slice(0, index + 1);
}

function parseMapGeometry(value: FeatureRow["geometry"]): MapGeometry {
  const geometry: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!geometry || typeof geometry !== "object" || !("type" in geometry) || !("coordinates" in geometry)) {
    throw new Error("PostGIS returned an invalid GeoJSON geometry");
  }
  const coordinates = geometry.coordinates;
  if (geometry.type === "Point" && isPosition(coordinates)) return { type: "Point", coordinates };
  if (geometry.type === "LineString" && isLineString(coordinates)) return { type: "LineString", coordinates };
  if (geometry.type === "Polygon" && isPolygon(coordinates)) return { type: "Polygon", coordinates };
  if (geometry.type === "MultiPolygon" && isMultiPolygon(coordinates)) return { type: "MultiPolygon", coordinates };
  throw new Error("PostGIS returned an unsupported GeoJSON geometry");
}

function parseFeatureKind(value: string): NonNullable<MapFeature["properties"]["featureKind"]> {
  if (["area", "facility", "linear", "segment", "barrier", "consequence"].includes(value)) {
    return value as NonNullable<MapFeature["properties"]["featureKind"]>;
  }
  throw new Error("PostGIS returned an unsupported map feature kind");
}

function parseHealth(value: string | null): NonNullable<MapFeature["properties"]["health"]> | null {
  if (value === null) return null;
  if (["healthy", "degraded", "failed", "unverified"].includes(value.toLowerCase())) {
    return value.toLowerCase() as NonNullable<MapFeature["properties"]["health"]>;
  }
  return null;
}

function parseRiskBand(value: string | null): NonNullable<MapFeature["properties"]["riskBand"]> | null {
  if (value === null) return null;
  if (["intolerable", "alarp", "acceptable"].includes(value.toLowerCase())) {
    return value.toLowerCase() as NonNullable<MapFeature["properties"]["riskBand"]>;
  }
  return null;
}

function isPosition(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === 2 && value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate));
}

function isLineString(value: unknown): value is number[][] {
  return Array.isArray(value) && value.length >= 2 && value.every(isPosition);
}

function isPolygon(value: unknown): value is number[][][] {
  return Array.isArray(value) && value.length > 0 && value.every((ring) => Array.isArray(ring) && ring.length >= 4 && ring.every(isPosition));
}

function isMultiPolygon(value: unknown): value is number[][][][] {
  return Array.isArray(value) && value.length > 0 && value.every(isPolygon);
}

function featureLimitForZoom(zoom: number): number {
  if (zoom < 5) return 1_000;
  if (zoom < 9) return 10_000;
  return MAX_FEATURES;
}

const ASSET_LAYER_SQL = `
WITH visible_asset AS (
  SELECT a.id, a.type, a.attributes, a.domain_pack, a.simulated, a.classification,
         ST_AsGeoJSON(a.geom)::jsonb AS geometry,
         COALESCE(a.attributes->>'name', a.attributes->>'asset_code', a.id::text) AS name,
         a.attributes->>'asset_code' AS code,
         a.attributes->>'label' AS label,
         a.attributes->>'risk_band' AS risk_band
  FROM app.asset a
  WHERE a.org_id = $5 AND (a.classification = ANY($6::text[]) OR
    ($8::boolean AND a.simulated IS TRUE AND a.created_by IN ('seed:dl-01', 'seed:bangkok')))
    AND a.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
    AND a.geom IS NOT NULL
    AND (a.type IN ('area', 'facility') OR (a.type = 'linear' AND NOT EXISTS (
      SELECT 1 FROM app.segment existing_segment WHERE existing_segment.asset_id = a.id AND existing_segment.org_id = a.org_id
    )))
  ORDER BY a.type, name
  LIMIT $7
), visible_segment AS (
  SELECT s.id, s.chainage_from, s.chainage_to, s.simulated, s.classification,
         ST_AsGeoJSON(s.geom)::jsonb AS geometry,
         COALESCE(a.attributes->>'name', a.attributes->>'asset_code', a.id::text) || ' · ' ||
           COALESCE(s.chainage_from::text, '?') || '–' || COALESCE(s.chainage_to::text, '?') || ' m' AS name,
         a.attributes->>'asset_code' AS code,
         a.attributes->>'label' AS label,
         a.attributes->>'risk_band' AS risk_band,
         a.domain_pack
  FROM app.segment s
  JOIN app.asset a ON a.id = s.asset_id AND a.org_id = s.org_id
  WHERE s.org_id = $5 AND (s.classification = ANY($6::text[]) OR
    ($8::boolean AND s.simulated IS TRUE AND s.created_by IN ('seed:dl-01', 'seed:bangkok')))
    AND (a.classification = ANY($6::text[]) OR
      ($8::boolean AND a.simulated IS TRUE AND a.created_by IN ('seed:dl-01', 'seed:bangkok')))
    AND s.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
    AND s.geom IS NOT NULL
  ORDER BY s.chainage_from NULLS LAST
  LIMIT $7
)
SELECT id::text, geometry, name, code, type AS feature_kind, classification, simulated, label,
       NULL::text AS health, risk_band, NULL::numeric AS chainage_from, NULL::numeric AS chainage_to,
       NULL::text AS evidence_observed_at, domain_pack
FROM visible_asset
UNION ALL
SELECT id::text, geometry, name, code, 'segment' AS feature_kind, classification, simulated, label,
       NULL::text AS health, risk_band, chainage_from, chainage_to, NULL::text AS evidence_observed_at, domain_pack
FROM visible_segment`;

// Barrier locations come only from a confirmed GeoReference attached to evidence. The database
// seed has no exact Chainage for several pipeline Barriers; those are deliberately not placed.
export const BARRIER_LAYER_SQL = `
WITH latest_location AS (
  SELECT DISTINCT ON (b.id)
         b.id, b.name, b.type, b.health, b.classification, b.simulated,
         e.observed_at, gr.geom, gr.classification AS geo_classification, a.domain_pack,
         a.attributes->>'name' AS asset_name, a.attributes->>'asset_code' AS asset_code,
         a.attributes->>'label' AS label
  FROM app.barrier b
  JOIN app.evidence e ON e.barrier_id = b.id AND e.org_id = b.org_id
  JOIN app.geo_reference gr ON gr.evidence_id = e.id AND gr.org_id = e.org_id
  JOIN app.asset a ON gr.target_type = 'asset' AND gr.target_id = a.id AND a.org_id = gr.org_id
  WHERE b.org_id = $5 AND (b.classification = ANY($6::text[]) OR
    ($8::boolean AND b.simulated IS TRUE AND b.created_by IN ('seed:dl-01', 'seed:bangkok')))
    AND b.health IN ('degraded', 'failed', 'unverified')
    AND (e.classification = ANY($6::text[]) OR
      ($8::boolean AND e.simulated IS TRUE AND e.created_by IN ('seed:dl-01', 'seed:bangkok')))
    AND (gr.classification = ANY($6::text[]) OR
      ($8::boolean AND gr.simulated IS TRUE AND gr.created_by IN ('seed:dl-01', 'seed:bangkok')))
    AND (a.classification = ANY($6::text[]) OR
      ($8::boolean AND a.simulated IS TRUE AND a.created_by IN ('seed:dl-01', 'seed:bangkok')))
    AND gr.status = 'confirmed' AND gr.geom IS NOT NULL
  ORDER BY b.id, e.observed_at DESC, gr.created_at DESC
), visible_location AS (
  SELECT * FROM latest_location
  WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
  ORDER BY observed_at DESC, id
  LIMIT $7
)
SELECT id::text, ST_AsGeoJSON(CASE WHEN GeometryType(geom) = 'POINT' THEN geom ELSE ST_PointOnSurface(geom) END)::jsonb AS geometry,
       COALESCE(name, asset_name, id::text) AS name, asset_code AS code,
       'barrier' AS feature_kind, classification, simulated, label, health,
       NULL::text AS risk_band, NULL::numeric AS chainage_from, NULL::numeric AS chainage_to,
       observed_at::text AS evidence_observed_at, domain_pack
FROM visible_location`;

const CONSEQUENCE_LAYER_SQL = `
SELECT c.id::text || ':' || a.id::text AS id, ST_AsGeoJSON(a.geom)::jsonb AS geometry,
       b.top_event AS name, a.attributes->>'asset_code' AS code, 'consequence' AS feature_kind,
       c.classification, c.simulated, a.attributes->>'label' AS label,
       NULL::text AS health, NULL::text AS risk_band, NULL::numeric AS chainage_from,
       NULL::numeric AS chainage_to, NULL::text AS evidence_observed_at, a.domain_pack
FROM app.consequence c
JOIN app.bowtie b ON b.id = c.bowtie_id AND b.org_id = c.org_id
JOIN app.bowtie_asset ba ON ba.bowtie_id = c.bowtie_id AND ba.org_id = c.org_id
JOIN app.asset a ON a.id = ba.asset_id AND a.org_id = ba.org_id
WHERE c.org_id = $5 AND (c.classification = ANY($6::text[]) OR
    ($8::boolean AND c.simulated IS TRUE AND c.created_by IN ('seed:dl-01', 'seed:bangkok')))
  AND (b.classification = ANY($6::text[]) OR
    ($8::boolean AND b.simulated IS TRUE AND b.created_by IN ('seed:dl-01', 'seed:bangkok')))
  AND (ba.classification = ANY($6::text[]) OR
    ($8::boolean AND ba.simulated IS TRUE AND ba.created_by IN ('seed:dl-01', 'seed:bangkok')))
  AND (a.classification = ANY($6::text[]) OR
    ($8::boolean AND a.simulated IS TRUE AND a.created_by IN ('seed:dl-01', 'seed:bangkok')))
  AND a.type = 'area'
  AND a.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
  AND a.geom IS NOT NULL
ORDER BY c.id, a.id
LIMIT $7`;
