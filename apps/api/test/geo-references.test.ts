import { afterEach, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { buildApp } from "../src/app.js";
import { AuthError, type AuthServicePort, type CurrentUser } from "../src/auth/service.js";
import type { GeoReferenceStore, GeoScope } from "../src/geo-references/model.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function fixture(roles = ["fieldloop.operator"]) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const publicJwk = { ...await exportJWK(publicKey), kid: "test-kid", use: "sig", alg: "RS256" };
  const user: CurrentUser = {
    sub: "synthetic-reviewer", roles, persona: "Integrity Engineer", orgId: "synthetic-org",
    clearance: "INTERNAL", csrfToken: "fixture-csrf", authTime: new Date(),
  };
  const auth: AuthServicePort = {
    getCurrentUser: async (cookie) => { if (cookie !== "valid") throw new AuthError("Session required", 401); return user; },
    startLogin: async () => new URL("https://example.test"), startReauthentication: async () => new URL("https://example.test"),
    completeLogin: async () => { throw new Error("unused"); }, issueInternalUserToken: async () => "unused",
    logout: async () => new URL("https://example.test"), backchannelLogout: async () => {},
    jwks: async () => ({ keys: [publicJwk as JWK] }),
  };
  const store: GeoReferenceStore = {
    getSource: vi.fn(async (documentId: string, scope: GeoScope) => ({
      id: documentId, title: "Synthetic document", folder: "Safety", text: "KP 45+200",
      simulated: true, classification: scope.clearance,
    })),
    createDrafts: vi.fn(async () => ({ references: [], replayed: false })),
    listDrafts: vi.fn(async (_scope: GeoScope, _cursor: string | undefined, limit: number) => ({ items: [], limit, nextCursor: null })),
    decide: vi.fn(async (input: Parameters<GeoReferenceStore["decide"]>[0]) => ({
      id: input.geoReferenceId, documentId: "00000000-0000-4000-8000-000000000091", documentTitle: "Synthetic document",
      kind: "point" as const, geometry: { type: "Point" as const, coordinates: [100, 13] }, chainageFrom: null, chainageTo: null,
      proposedLabel: null, sourceSnippet: "location", confidence: 0.9, targetAssetId: null,
      status: input.decision === "confirm" ? "confirmed" as const : "rejected" as const, simulated: true,
      classification: "INTERNAL", createdAt: new Date().toISOString(),
    })),
  };
  const app = buildApp({ auth, geoReferences: store, baseUrl: "https://fieldloop.test" });
  apps.push(app);
  const internalToken = await new SignJWT({ roles, clearance: "INTERNAL", org_id: "synthetic-org" })
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: "test-kid" })
    .setIssuer("https://fieldloop.test").setAudience("fieldloop-services")
    .setSubject("synthetic-reviewer").setJti("synthetic-jti")
    .setIssuedAt().setExpirationTime("5m").sign(privateKey);
  return { app, auth, store, user, internalToken };
}

it("requires a signed internal user token for assistant document reads", async () => {
  const { app, store, internalToken } = await fixture();
  const documentId = "00000000-0000-4000-8000-000000000091";
  const path = `/api/internal/assistant/documents/${documentId}/geo-source`;
  expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(401);
  const response = await app.inject({ method: "GET", url: path, headers: { authorization: `Bearer ${internalToken}` } });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ id: documentId, text: "KP 45+200", classification: "INTERNAL" });
  expect(store.getSource).toHaveBeenCalledWith(documentId, expect.objectContaining({ sub: "synthetic-reviewer", orgId: "synthetic-org" }));
});

it("accepts only validated draft candidates on the internal create route", async () => {
  const { app, store, internalToken } = await fixture();
  const documentId = "00000000-0000-4000-8000-000000000091";
  const payload = { references: [{
    latitude: null, longitude: null, chainageFrom: 45_200, chainageTo: null,
    assetCode: null, placeName: null, sourceSnippet: "KP 45+200", confidence: 0.85,
  }] };
  const response = await app.inject({
    method: "POST", url: `/api/internal/assistant/documents/${documentId}/geo-references`,
    headers: { "x-fieldloop-internal-user-token": internalToken, "idempotency-key": "geo-reference-test-001" },
    payload,
  });
  expect(response.statusCode).toBe(201);
  expect(store.createDrafts).toHaveBeenCalledWith(expect.objectContaining({ documentId, references: payload.references }));
  const invalid = await app.inject({
    method: "POST", url: `/api/internal/assistant/documents/${documentId}/geo-references`,
    headers: { "x-fieldloop-internal-user-token": internalToken, "idempotency-key": "geo-reference-test-002" },
    payload: { references: [{ ...payload.references[0], status: "confirmed" }] },
  });
  expect(invalid.statusCode).toBe(400);
});

it("keeps human Geo Reference decisions behind session, CSRF and Operator or Manager roles", async () => {
  const { app, store, user } = await fixture(["fieldloop.viewer"]);
  const id = "00000000-0000-4000-8000-000000000092";
  const url = `/api/v1/geo-references/${id}:confirm`;
  expect((await app.inject({ method: "POST", url, headers: { cookie: "fl_session=valid", "idempotency-key": "geo-confirm-test-0001" } })).statusCode).toBe(403);
  const forbidden = await app.inject({
    method: "POST", url, headers: { cookie: "fl_session=valid", "x-csrf-token": user.csrfToken, "idempotency-key": "geo-confirm-test-0002" },
  });
  expect(forbidden.statusCode).toBe(403);
  expect(store.decide).not.toHaveBeenCalled();

  const authorized = await fixture(["fieldloop.operator"]);
  const confirmed = await authorized.app.inject({
    method: "POST", url,
    headers: { cookie: "fl_session=valid", "x-csrf-token": authorized.user.csrfToken, "idempotency-key": "geo-confirm-test-0003" },
    payload: {},
  });
  expect(confirmed.statusCode).toBe(200);
  expect(confirmed.json()).toMatchObject({ id, status: "confirmed" });
  expect(authorized.store.decide).toHaveBeenCalledWith(expect.objectContaining({ decision: "confirm", geoReferenceId: id }));
});

it("lists draft Geo References through the authenticated session", async () => {
  const { app, store, user } = await fixture();
  const response = await app.inject({
    method: "GET", url: "/api/v1/geo-references?status=draft&limit=25", cookies: { fl_session: "valid" },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ items: [], limit: 25, nextCursor: null });
  expect(store.listDrafts).toHaveBeenCalledWith(user, undefined, 25);
});
