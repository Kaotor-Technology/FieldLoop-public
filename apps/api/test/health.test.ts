import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { AuthError, type AuthServicePort, type CurrentUser } from "../src/auth/service.js";
import type { HealthServicePort } from "../src/health/model.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
function fixture() {
  const user: CurrentUser = { sub: "synthetic-owner", roles: ["fieldloop.operator"], persona: "Integrity Engineer",
    orgId: "test-org", clearance: "HIGHLY_RESTRICTED", csrfToken: "fixture-csrf", authTime: new Date("2026-10-13T00:00:00Z") };
  const auth: AuthServicePort = {
    getCurrentUser: async (cookie) => { if (cookie !== "valid") throw new AuthError("Session required", 401); return user; },
    startLogin: async () => new URL("https://example.test"), startReauthentication: async () => new URL("https://example.test"),
    completeLogin: async () => { throw new Error("unused"); }, issueInternalUserToken: async () => { throw new Error("unused"); },
    logout: async () => new URL("https://example.test"), backchannelLogout: async () => {}, jwks: async () => ({ keys: [] }),
  };
  const health: HealthServicePort = {
    decide: vi.fn().mockResolvedValue({ healthProposalId: randomUUID(), status: "accepted", barrierId: randomUUID(), health: "degraded" }),
    listProposals: vi.fn(async (_user, _cursor, limit) => ({ items: [], limit, nextCursor: null })),
    listNotifications: vi.fn(async (_user, _cursor, limit) => ({ items: [], limit, nextCursor: null })),
    latestEventPosition: vi.fn().mockResolvedValue({ createdAt: "2026-10-13 00:00:00+00", id: "00000000-0000-0000-0000-000000000000" }),
    listEvents: vi.fn().mockResolvedValue([]),
  };
  const app = buildApp({ auth, health }); apps.push(app);
  const headers = { cookie: "fl_session=valid", "x-csrf-token": "fixture-csrf", "idempotency-key": "eeeeeeeeeeeeeeee" };
  return { app, user, health, headers };
}

it("accepts and rejects proposals with session, CSRF, role, reason and idempotency", async () => {
  const { app, user, health, headers } = fixture();
  const id = "00000000-0000-4000-8000-000000000082";
  const url = `/api/v1/health-proposals/${id}:accept`;
  const payload = { reason: "  Confirmed against the latest inspection.  " };
  expect((await app.inject({ method: "POST", url, payload, headers: { ...headers, cookie: "fl_session=missing" } })).statusCode).toBe(401);
  expect((await app.inject({ method: "POST", url, payload, headers: { cookie: headers.cookie } })).statusCode).toBe(403);
  user.roles = ["fieldloop.viewer"];
  expect((await app.inject({ method: "POST", url, payload, headers })).statusCode).toBe(403);
  expect(health.decide).not.toHaveBeenCalled();
  user.roles = ["fieldloop.operator"];
  const accepted = await app.inject({ method: "POST", url, payload, headers });
  expect(accepted.statusCode).toBe(200);
  expect(health.decide).toHaveBeenCalledWith({ user, proposalId: id, decision: "accept", reason: "Confirmed against the latest inspection.", idempotencyKey: headers["idempotency-key"] });
  const rejected = await app.inject({ method: "POST", url: `/api/v1/health-proposals/${id}:reject`, payload: { reason: "Inspection evidence is insufficient." }, headers });
  expect(rejected.statusCode).toBe(200);
  expect(health.decide).toHaveBeenLastCalledWith({ user, proposalId: id, decision: "reject", reason: "Inspection evidence is insufficient.", idempotencyKey: headers["idempotency-key"] });
});

it("rejects empty reasons and missing or malformed idempotency keys", async () => {
  const { app, health, headers } = fixture();
  const url = "/api/v1/health-proposals/00000000-0000-4000-8000-000000000082:reject";
  expect((await app.inject({ method: "POST", url, payload: { reason: "   " }, headers })).statusCode).toBe(400);
  expect((await app.inject({ method: "POST", url, payload: { reason: "A decision" }, headers: { cookie: headers.cookie, "x-csrf-token": headers["x-csrf-token"] } })).statusCode).toBe(400);
  expect(health.decide).not.toHaveBeenCalled();
});

it("returns validated, scoped notification pages", async () => {
  const { app, user, health, headers } = fixture();
  const response = await app.inject({ method: "GET", url: "/api/v1/notifications?cursor=opaque-cursor&limit=25", headers });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ items: [], limit: 25, nextCursor: null });
  expect(health.listNotifications).toHaveBeenCalledWith(user, "opaque-cursor", 25);
  expect((await app.inject({ method: "GET", url: "/api/v1/notifications?limit=201", headers })).statusCode).toBe(400);
});

it("returns validated, owner-scoped open Health Proposal pages", async () => {
  const { app, user, health, headers } = fixture();
  const response = await app.inject({ method: "GET", url: "/api/v1/health-proposals?status=open&cursor=opaque-cursor&limit=25", headers });
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.json()).toEqual({ items: [], limit: 25, nextCursor: null });
  expect(health.listProposals).toHaveBeenCalledWith(user, "opaque-cursor", 25);
  expect((await app.inject({ method: "GET", url: "/api/v1/health-proposals?status=accepted", headers })).statusCode).toBe(400);
  expect((await app.inject({ method: "GET", url: "/api/v1/health-proposals?status=open&limit=201", headers })).statusCode).toBe(400);
  expect((await app.inject({ method: "GET", url: "/api/v1/health-proposals?status=open", headers: {} })).statusCode).toBe(401);
});

it("streams health events and resumes with the returned cursor", async () => {
  const { app, headers, health } = fixture();
  const event = { id: randomUUID(), type: "barrier.health_changed" as const, orgId: "test-org", entityId: randomUUID(),
    barrierId: randomUUID(), simulated: true, classification: "CONFIDENTIAL" as const };
  vi.mocked(health.listEvents).mockResolvedValueOnce([{ position: { createdAt: "2026-10-13 00:01:00+00", id: event.id }, event }]);
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  const abort = new AbortController();
  const response = await fetch(`${base}/api/v1/events`, { headers: { cookie: headers.cookie }, signal: abort.signal });
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  if (!response.body) throw new Error("Stream has no body");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = "";
  while (!text.includes("event: barrier.health_changed")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("Stream ended before the health event");
    text += decoder.decode(chunk.value);
  }
  expect(text).toContain(event.barrierId);
  expect(text).toMatch(/id: [A-Za-z0-9_-]+/);
  await reader.cancel(); abort.abort();
});
