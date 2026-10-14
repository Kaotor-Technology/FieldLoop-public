import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { ActionError, type ActionServicePort } from "@fieldloop/adapters";
import { buildApp } from "../src/app.js";
import { AuthError, type AuthServicePort, type CurrentUser } from "../src/auth/service.js";
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
function fixture() {
  const user: CurrentUser = { sub: "synthetic-operator", roles: ["fieldloop.operator"], orgId: "synthetic-org", clearance: "INTERNAL", persona: "Integrity Engineer", csrfToken: "synthetic-csrf", authTime: new Date() };
  const auth: AuthServicePort = {
    getCurrentUser: async cookie => { if (cookie !== "valid") throw new AuthError("Session required", 401); return user; },
    startLogin: async () => new URL("https://example.test"), startReauthentication: async () => new URL("https://example.test"),
    completeLogin: async () => { throw new Error("unused"); }, issueInternalUserToken: async () => { throw new Error("unused"); },
    logout: async () => new URL("https://example.test"), backchannelLogout: async () => {}, jwks: async () => ({ keys: [] }),
  };
  const body = { actionType: "system_of_record", actionLevel: "l1", target: "cmms", payload: { title: "Synthetic work order" }, rationale: "Prepare for human entry", citations: ["synthetic:procedure"], simulated: true, classification: "INTERNAL" };
  const action = { ...body, id: randomUUID(), orgId: user.orgId, requestedBy: user.sub, status: "open", payloadHash: "a".repeat(64), expiresAt: new Date(Date.now()+900_000).toISOString() };
  const actions: ActionServicePort = { create: vi.fn().mockResolvedValue(action), get: vi.fn().mockResolvedValue(action), check: vi.fn(), expire: vi.fn() };
  const app = buildApp({ auth, actions }); apps.push(app);
  const headers = { cookie: "fl_session=valid", "x-csrf-token": user.csrfToken, "idempotency-key": "synthetic-create-key" };
  return { app, body, actions, headers, user, action };
}
it("creates complete proposals with a cookie session, CSRF and idempotency", async () => {
  const { app, body, actions, headers, user, action } = fixture();
  const result = await app.inject({ method: "POST", url: "/api/v1/action-requests", payload: body, headers });
  expect(result.statusCode).toBe(201); expect(result.json()).toEqual(action);
  expect(result.headers["location"]).toBe(`/api/v1/action-requests/${action.id}`);
  expect(result.headers["cache-control"]).toBe("private, no-store");
  expect(actions.create).toHaveBeenCalledWith(user, body, headers["idempotency-key"]);
});
it("rejects unauthenticated, CSRF-less, viewer and spoofed proposals before storage", async () => {
  const { app, body, actions, headers, user } = fixture();
  const inject = (payload: unknown, requestHeaders: Record<string,string>) => app.inject({ method: "POST", url: "/api/v1/action-requests", payload: JSON.stringify(payload), headers: { "content-type": "application/json", ...requestHeaders } });
  expect((await inject(body, {})).statusCode).toBe(401);
  expect((await inject(body, { cookie: headers.cookie })).statusCode).toBe(403);
  user.roles=["fieldloop.viewer"]; expect((await inject(body, headers)).statusCode).toBe(403);
  user.roles=["fieldloop.operator"];
  for (const extra of [{ actionLevel: "l3" }, { requestedBy: "spoofed" }, { payloadHash: "fake" }, { status: "approved" }]) expect((await inject({ ...body,...extra }, headers)).statusCode).toBe(400);
  expect(actions.create).not.toHaveBeenCalled();
});
it("returns scoped records and RFC 9457 storage failures", async () => {
  const { app, actions, action, user, headers, body } = fixture();
  expect((await app.inject({ method: "GET", url: `/api/v1/action-requests/${action.id}`, headers })).statusCode).toBe(200);
  expect(actions.get).toHaveBeenCalledWith(user, action.id);
  vi.mocked(actions.create).mockRejectedValueOnce(new ActionError(409,"idempotency_key_reused"));
  const conflict = await app.inject({ method: "POST", url: "/api/v1/action-requests", payload: body, headers });
  expect(conflict.statusCode).toBe(409); expect(conflict.headers["content-type"]).toContain("application/problem+json");
  vi.mocked(actions.create).mockRejectedValueOnce(new Error("secret database detail"));
  const failed = await app.inject({ method: "POST", url: "/api/v1/action-requests", payload: body, headers });
  expect(failed.statusCode).toBe(503); expect(failed.body).not.toContain("secret database detail");
});
