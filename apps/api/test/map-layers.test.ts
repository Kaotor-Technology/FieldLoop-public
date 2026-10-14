import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { AuthError, type AuthServicePort } from "../src/auth/service.js";
import { ASSET_BY_ID_SQL, ASSET_LAYER_SQL, BARRIER_LAYER_SQL, GEO_REFERENCE_LAYER_SQL, RISK_INPUT_SQL, type AssetRecord, type MapFeatureCollection, type MapLayerStore } from "../src/map/layers.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

const DL01: AssetRecord = {
  id: "11111111-2222-4333-8444-555555555555", type: "linear", name: "SYNTHETIC pipeline", code: "DL-01",
  label: "SYNTHETIC", domainPack: "pipeline-integrity", simulated: true, classification: "INTERNAL",
  geometry: null,
};

describe("asset by id API", () => {
  it("requires authentication and a well-formed identifier", async () => {
    const store = makeStore(DL01);
    const app = makeApp({}, store);
    expect((await app.inject({ method: "GET", url: "/api/v1/assets/DL-01" })).statusCode).toBe(401);
    for (const url of ["/api/v1/assets/a%20b%3B--", "/api/v1/assets/.", "/api/v1/assets/..x"]) {
      const bad = await app.inject({ method: "GET", url, cookies: { fl_session: "opaque-session-value" } });
      expect(bad.statusCode, url).toBe(400);
    }
    expect(store.getAsset).not.toHaveBeenCalled();
  });

  it("returns the scoped asset and a problem document when it is not visible", async () => {
    const found = makeStore(DL01);
    const ok = await makeApp({}, found).inject({
      method: "GET", url: "/api/v1/assets/DL-01", cookies: { fl_session: "opaque-session-value" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ code: "DL-01", simulated: true });
    expect(found.getAsset).toHaveBeenCalledWith({
      assetId: "DL-01", orgId: "synthetic-org", clearance: "INTERNAL", allowSeededDemoGeometry: true,
    });
    const missing = await makeApp({}, makeStore(null)).inject({
      method: "GET", url: "/api/v1/assets/DL-99", cookies: { fl_session: "opaque-session-value" },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["content-type"]).toContain("application/problem+json");
  });

  it("filters by Organisation, clearance and the seeded demo rule in SQL", () => {
    expect(ASSET_BY_ID_SQL).toContain("a.id::text = lower($2)");
    expect(ASSET_BY_ID_SQL).toContain("ORDER BY (a.id::text = lower($2)) DESC");
    expect(ASSET_BY_ID_SQL).toContain("a.org_id = $1");
    expect(ASSET_BY_ID_SQL).toContain("a.classification = ANY($3::text[])");
    expect(ASSET_BY_ID_SQL).toContain("a.created_by IN ('seed:dl-01', 'seed:bangkok')");
  });
});

describe("internal user token reads", () => {
  const claims = { sub: "assistant-user", roles: ["fieldloop.operator"], persona: "Integrity Engineer",
    orgId: "synthetic-org", clearance: "INTERNAL", csrfToken: "", authTime: new Date(0) };
  const bearer = { authorization: "Bearer five-minute-internal-user-token" };

  it("reads as the token's user without a session cookie", async () => {
    const store = makeStore(DL01);
    const fromToken = vi.fn(async () => claims);
    const app = makeApp({ getCurrentUserFromInternalToken: fromToken }, store);
    const response = await app.inject({ method: "GET", url: "/api/v1/assets/DL-01", headers: bearer });
    expect(response.statusCode).toBe(200);
    expect(fromToken).toHaveBeenCalledWith("five-minute-internal-user-token");
    expect(store.getAsset).toHaveBeenCalledWith(expect.objectContaining({ orgId: "synthetic-org" }));
  });

  it("never allows a state change, a decision or the event stream", async () => {
    const fromToken = vi.fn(async () => claims);
    const app = makeApp({ getCurrentUserFromInternalToken: fromToken }, makeStore());
    const post = await app.inject({ method: "POST", url: "/api/v1/action-requests", headers: bearer, payload: {} });
    const decision = await app.inject({
      method: "POST", url: "/api/v1/health-proposals/11111111-2222-4333-8444-555555555555:accept",
      headers: bearer, payload: {},
    });
    const stream = await app.inject({ method: "GET", url: "/api/v1/events", headers: bearer });
    const authRoute = await app.inject({ method: "GET", url: "/api/auth/reauth", headers: bearer });
    // The header is ignored there, so a bearer-only request is simply unauthenticated.
    for (const response of [post, decision, stream, authRoute]) expect(response.statusCode).toBe(401);
    expect(fromToken).not.toHaveBeenCalled();
  });

  it("is accepted only on the routes behind the assistant tools", async () => {
    const fromToken = vi.fn(async () => claims);
    const app = makeApp({ getCurrentUserFromInternalToken: fromToken }, makeStore(DL01));
    for (const url of ["/api/v1/map/layers/assets?bbox=99,13,101,15&zoom=8", "/api/v1/audit", "/api/v1/notifications"]) {
      const response = await app.inject({ method: "GET", url, headers: bearer });
      expect(response.statusCode, url).toBe(401);
    }
    expect(fromToken).not.toHaveBeenCalled();
  });

  it("gives a bearer plus a cookie no extra power and ignores it on /me and HEAD", async () => {
    const fromToken = vi.fn(async () => claims);
    const app = makeApp({ getCurrentUserFromInternalToken: fromToken }, makeStore(DL01));
    const cookies = { fl_session: "opaque-session-value" };
    const post = await app.inject({
      method: "POST", url: "/api/v1/action-requests", headers: bearer, cookies, payload: {},
    });
    const head = await app.inject({ method: "HEAD", url: "/api/v1/assets/DL-01", headers: bearer });
    const encoded = await app.inject({ method: "GET", url: "/%61pi/v1/events", headers: bearer });
    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: bearer });
    // POST falls to the cookie path, which demands a CSRF token the bearer never supplies.
    expect(post.statusCode).toBe(403);
    expect([head.statusCode, encoded.statusCode, me.statusCode].every((code) => code === 401 || code === 404)).toBe(true);
    expect(fromToken).not.toHaveBeenCalled();
  });

  it("rejects an unverifiable token and does not fall back to a cookie identity", async () => {
    const app = makeApp({
      getCurrentUserFromInternalToken: vi.fn(async () => { throw new AuthError("failed", 401); }),
    }, makeStore(DL01));
    const response = await app.inject({
      method: "GET", url: "/api/v1/assets/DL-01", headers: bearer, cookies: { fl_session: "opaque-session-value" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("is ignored where the auth service cannot verify internal tokens", async () => {
    const app = makeApp({}, makeStore(DL01));
    const response = await app.inject({ method: "GET", url: "/api/v1/assets/DL-01", headers: bearer });
    expect(response.statusCode).toBe(401);
  });
});

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

function makeStore(asset: AssetRecord | null = null): MapLayerStore & {
  getLayer: ReturnType<typeof vi.fn>;
  getAsset: ReturnType<typeof vi.fn>;
} {
  return {
    getLayer: vi.fn(async () => ({ type: "FeatureCollection", features: [] }) satisfies MapFeatureCollection),
    getAsset: vi.fn(async () => asset),
  };
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
