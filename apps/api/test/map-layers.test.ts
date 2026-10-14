import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { AuthError, type AuthServicePort } from "../src/auth/service.js";
import { ASSET_LAYER_SQL, BARRIER_LAYER_SQL, GEO_REFERENCE_LAYER_SQL, RISK_INPUT_SQL, type MapFeatureCollection, type MapLayerStore } from "../src/map/layers.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("map layer API", () => {
  it("requires an authenticated session before accessing a layer", async () => {
    const store = makeStore();
    const app = makeApp({}, store);
    const response = await app.inject({ method: "GET", url: "/api/v1/map/layers/assets?bbox=99,13,101,15&zoom=8" });
    expect(response.statusCode).toBe(401);
    expect(store.getLayer).not.toHaveBeenCalled();
  });

  it("rejects invalid viewport values before querying PostGIS", async () => {
    const store = makeStore();
    const app = makeApp({}, store);
    const response = await app.inject({
      method: "GET", url: "/api/v1/map/layers/assets?bbox=101,13,99,15&zoom=8",
      cookies: { fl_session: "opaque-session-value" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(store.getLayer).not.toHaveBeenCalled();
  });

  it("passes organisation, clearance and demo-role scope from the session to the layer store", async () => {
    const store = makeStore();
    const app = makeApp({ getCurrentUser: vi.fn(async () => ({
      sub: "synthetic-viewer", roles: ["fieldloop.viewer"], persona: "Executive", orgId: "synthetic-org",
      clearance: "INTERNAL", csrfToken: "csrf-value", authTime: new Date(),
    })) }, store);
    const response = await app.inject({
      method: "GET", url: "/api/v1/map/layers/barriers?bbox=99,13,101,15&zoom=8",
      cookies: { fl_session: "opaque-session-value" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["content-type"]).toContain("application/geo+json");
    expect(store.getLayer).toHaveBeenCalledWith({
      layer: "barriers", bbox: [99, 13, 101, 15], zoom: 8, orgId: "synthetic-org",
      clearance: "INTERNAL", allowSeededDemoGeometry: true,
    });
  });

  it("selects each Barrier's latest confirmed location before applying the viewport predicate", async () => {
    const latestSelection = BARRIER_LAYER_SQL.indexOf("ORDER BY b.id, e.observed_at DESC, gr.created_at DESC");
    const viewportFilter = BARRIER_LAYER_SQL.indexOf("WHERE geom && ST_MakeEnvelope");
    expect(latestSelection).toBeGreaterThanOrEqual(0);
    expect(viewportFilter).toBeGreaterThan(latestSelection);
    expect(BARRIER_LAYER_SQL).toContain("SELECT * FROM latest_location");
  });

  it("does not place Barriers at an arbitrary point on their full linear Asset", () => {
    expect(BARRIER_LAYER_SQL).toContain("GeometryType(gr.geom) NOT IN ('LINESTRING', 'MULTILINESTRING')");
  });

  it("returns only confirmed, current, clearance-scoped Geo References on the Geo Reference layer", async () => {
    const store = makeStore();
    const app = makeApp({ getCurrentUser: vi.fn(async () => ({
      sub: "synthetic-viewer", roles: ["fieldloop.viewer"], persona: "Executive", orgId: "synthetic-org",
      clearance: "INTERNAL", csrfToken: "csrf-value", authTime: new Date(),
    })) }, store);
    const response = await app.inject({
      method: "GET", url: "/api/v1/map/layers/geo-references?bbox=99,13,101,15&zoom=8",
      cookies: { fl_session: "opaque-session-value" },
    });
    expect(response.statusCode).toBe(200);
    expect(store.getLayer).toHaveBeenCalledWith(expect.objectContaining({ layer: "geo-references" }));
    expect(GEO_REFERENCE_LAYER_SQL).toContain("gr.status = 'confirmed'");
    expect(GEO_REFERENCE_LAYER_SQL).toContain("gr.simulation_retired_at IS NULL");
    expect(GEO_REFERENCE_LAYER_SQL).toContain("gr.org_id = $5");
    expect(GEO_REFERENCE_LAYER_SQL).toContain("gr.classification = ANY($6::text[])");
    expect(GEO_REFERENCE_LAYER_SQL).toContain("d.status = 'current' AND d.superseded_by IS NULL");
  });

  it("attaches each Segment's parent Asset ID for shared Bowtie risk coloring", () => {
    expect(ASSET_LAYER_SQL).toContain("s.asset_id");
    expect(ASSET_LAYER_SQL).toContain("asset_id::text, geometry");
    expect(ASSET_LAYER_SQL).toContain("NULL::text AS risk_band");
    expect(ASSET_LAYER_SQL).not.toContain("attributes->>'risk_band'");
  });

  it("caps the combined Asset and Segment feature response at the viewport limit", () => {
    expect(ASSET_LAYER_SQL.trimEnd()).toMatch(/ORDER BY feature_kind, name, id\s+LIMIT \$7$/);
  });

  it("scopes demo Risk Matrix calculations to complete, simulated seed data in the current Organisation", () => {
    expect(RISK_INPUT_SQL).toContain("ba.org_id = $2");
    expect(RISK_INPUT_SQL).toContain("classification = ANY($3::text[])");
    expect(RISK_INPUT_SQL).toContain("a.simulated IS TRUE AND a.created_by IN ('seed:dl-01', 'seed:bangkok')");
    expect(RISK_INPUT_SQL).toContain("NOT EXISTS (SELECT 1 FROM app.threat");
    expect(RISK_INPUT_SQL).toContain("NOT EXISTS (SELECT 1 FROM app.consequence");
    expect(RISK_INPUT_SQL).toContain("app.barrier_path bp");
    expect(RISK_INPUT_SQL).toContain("app.independence_group ig");
    expect(RISK_INPUT_SQL).toContain("e.simulated IS TRUE AND e.created_by IN ('seed:dl-01', 'seed:bangkok')");
    expect(RISK_INPUT_SQL).toContain("latest_evidence.observed_at + b.evidence_interval <= statement_timestamp()");
    expect(RISK_INPUT_SQL).toContain("WHEN latest_evidence.observed_at IS NULL THEN TRUE");
  });
});

function makeStore(): MapLayerStore & { getLayer: ReturnType<typeof vi.fn> } {
  return { getLayer: vi.fn(async () => ({ type: "FeatureCollection", features: [] }) satisfies MapFeatureCollection) };
}

function makeApp(overrides: Partial<AuthServicePort>, store: MapLayerStore) {
  const auth = {
    getCurrentUser: async (sessionCookie?: string) => {
      if (!sessionCookie) throw new AuthError("Sign in required", 401);
      return ({
      sub: "synthetic-subject", roles: ["fieldloop.viewer"], persona: "Executive", orgId: "synthetic-org",
      clearance: "INTERNAL", csrfToken: "csrf-value", authTime: new Date(),
      });
    },
    ...overrides,
  } as AuthServicePort;
  const app = buildApp({ auth, mapLayers: store });
  apps.push(app);
  return app;
}
