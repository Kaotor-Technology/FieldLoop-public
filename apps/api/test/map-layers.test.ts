import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { AuthError, type AuthServicePort } from "../src/auth/service.js";
import { BARRIER_LAYER_SQL, type MapFeatureCollection, type MapLayerStore } from "../src/map/layers.js";

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
