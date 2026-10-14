import { afterEach, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { AuthError, type AuthServicePort, type CurrentUser } from "../src/auth/service.js";
import { AuditServiceError, type AuditServicePort } from "../src/audit/model.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function fixture() {
  const user: CurrentUser = { sub: "synthetic-manager", roles: ["fieldloop.manager"], persona: "Integrity Manager",
    orgId: "test-org", clearance: "CONFIDENTIAL", csrfToken: "fixture-csrf", authTime: new Date("2026-10-13T00:00:00Z") };
  const auth: AuthServicePort = {
    getCurrentUser: async (cookie) => { if (cookie !== "valid") throw new AuthError("Session required", 401); return user; },
    startLogin: async () => new URL("https://example.test"), startReauthentication: async () => new URL("https://example.test"),
    completeLogin: async () => { throw new Error("unused"); }, issueInternalUserToken: async () => { throw new Error("unused"); },
    logout: async () => new URL("https://example.test"), backchannelLogout: async () => {}, jwks: async () => ({ keys: [] }),
  };
  const audit: AuditServicePort = { listEvents: vi.fn(async (_user, _filter, _cursor, limit) => ({ items: [], limit, nextCursor: null })) };
  const app = buildApp({ auth, audit }); apps.push(app);
  return { app, user, audit, headers: { cookie: "fl_session=valid" } };
}

it("returns a scoped, validated, uncached audit page", async () => {
  const { app, user, audit, headers } = fixture();
  const response = await app.inject({ method: "GET", url: "/api/v1/audit?entityType=barrier&entityId=abc-1&cursor=opaque&limit=25", headers });
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.json()).toEqual({ items: [], limit: 25, nextCursor: null });
  expect(audit.listEvents).toHaveBeenCalledWith(user, { entityType: "barrier", entityId: "abc-1" }, "opaque", 25);
  await app.inject({ method: "GET", url: "/api/v1/audit", headers });
  expect(audit.listEvents).toHaveBeenLastCalledWith(user, {}, undefined, 50);
});

it.each([
  "entityType=Barrier", "entityType=bar.rier", "entityType=", "entityId=", `entityId=${"x".repeat(257)}`,
  "limit=0", "limit=201", "limit=ten", "cursor=", `cursor=${"c".repeat(513)}`, "unknown=1", "status=open",
])("rejects invalid query %s before calling the service", async (query) => {
  const { app, audit, headers } = fixture();
  const response = await app.inject({ method: "GET", url: `/api/v1/audit?${query}`, headers });
  expect(response.statusCode).toBe(400);
  expect(response.headers["content-type"]).toContain("application/problem+json");
  expect(audit.listEvents).not.toHaveBeenCalled();
});

it("requires a session and an operator or manager role", async () => {
  const { app, user, audit, headers } = fixture();
  expect((await app.inject({ method: "GET", url: "/api/v1/audit", headers: { cookie: "fl_session=missing" } })).statusCode).toBe(401);
  for (const roles of [["fieldloop.viewer"], []]) {
    user.roles = roles;
    expect((await app.inject({ method: "GET", url: "/api/v1/audit", headers })).statusCode).toBe(403);
  }
  user.roles = ["fieldloop.operator"];
  expect((await app.inject({ method: "GET", url: "/api/v1/audit", headers })).statusCode).toBe(200);
  expect(audit.listEvents).toHaveBeenCalledOnce();
});

it("offers no way to change audit events", async () => {
  const { app, headers } = fixture();
  for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
    const response = await app.inject({ method, url: "/api/v1/audit", headers: { ...headers, "x-csrf-token": "fixture-csrf" } });
    expect([404, 405]).toContain(response.statusCode);
  }
});

it("maps service failures to problem+json without leaking details", async () => {
  const { app, audit, headers } = fixture();
  vi.mocked(audit.listEvents).mockRejectedValueOnce(new AuditServiceError(400, "validation_failed"));
  expect((await app.inject({ method: "GET", url: "/api/v1/audit?cursor=bad", headers })).statusCode).toBe(400);
  vi.mocked(audit.listEvents).mockRejectedValueOnce(new Error("password=secret host=db.internal"));
  const failed = await app.inject({ method: "GET", url: "/api/v1/audit", headers });
  expect(failed.statusCode).toBe(503);
  expect(failed.body).not.toContain("secret");
});

it("reports the service as unavailable when no audit store is configured", async () => {
  const { user } = fixture();
  const auth: AuthServicePort = { getCurrentUser: async () => user } as unknown as AuthServicePort;
  const app = buildApp({ auth }); apps.push(app);
  expect((await app.inject({ method: "GET", url: "/api/v1/audit", headers: { cookie: "fl_session=valid" } })).statusCode).toBe(503);
});
