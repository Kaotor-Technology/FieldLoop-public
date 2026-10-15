import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { ActionError, APPROVAL_MAX_AUTH_AGE_MS, type ActionDecisionPort, type ActionServicePort } from "@fieldloop/adapters";
import { buildApp } from "../src/app.js";
import { AuthError, isRecentAuthTime, type AuthServicePort, type CurrentUser } from "../src/auth/service.js";
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
function fixture() {
  const user: CurrentUser = { sub: "synthetic-operator", roles: ["fieldloop.operator"], orgId: "synthetic-org", clearance: "INTERNAL", persona: "Integrity Engineer", csrfToken: "synthetic-csrf", authTime: new Date() };
  const auth: AuthServicePort = {
    getCurrentUser: vi.fn(async (cookie: string | undefined) => { if (cookie !== "valid") throw new AuthError("Session required", 401); return user; }),
    getCurrentUserFromInternalToken: async token => { if (token !== "internal") throw new AuthError("Token required", 401); return user; },
    startLogin: async () => new URL("https://example.test"), startReauthentication: async () => new URL("https://example.test"),
    completeLogin: async () => { throw new Error("unused"); }, issueInternalUserToken: async () => { throw new Error("unused"); },
    logout: async () => new URL("https://example.test"), backchannelLogout: async () => {}, jwks: async () => ({ keys: [] }),
  };
  const body = { actionType: "system_of_record", actionLevel: "l1", target: "cmms", payload: { title: "Synthetic work order" }, rationale: "Prepare for human entry", citations: ["synthetic:procedure"], simulated: true, classification: "INTERNAL" };
  const action = { ...body, id: randomUUID(), orgId: user.orgId, requestedBy: user.sub, requester: { kind: "person" }, status: "open", payloadHash: "a".repeat(64), expiresAt: new Date(Date.now()+900_000).toISOString() };
  const decided = { actionRequest: { ...action, status: "approved" }, approval: { id: randomUUID(), actionRequestId: action.id, approverSub: "synthetic-manager", decision: "approved", reason: "Reviewed", payloadHash: action.payloadHash, authTime: user.authTime.toISOString(), createdAt: new Date().toISOString() } };
  const actions: ActionServicePort & ActionDecisionPort = { create: vi.fn().mockResolvedValue(action), list: vi.fn().mockResolvedValue([action]), get: vi.fn().mockResolvedValue(action), check: vi.fn(), expire: vi.fn(), decide: vi.fn().mockResolvedValue(decided) };
  const app = buildApp({ auth, actions }); apps.push(app);
  const headers = { cookie: "fl_session=valid", "x-csrf-token": user.csrfToken, "idempotency-key": "synthetic-create-key" };
  return { app, body, actions, headers, user, action, auth, decided };
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
it("lists a bounded set of Action Requests for the signed-in user", async () => {
  const { app, actions, user, action } = fixture();
  const response = await app.inject({ method: "GET", url: "/api/v1/action-requests?limit=25", headers: { authorization: "Bearer internal" } });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual([action]);
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(actions.list).toHaveBeenCalledWith(user, 25);
  expect((await app.inject({ method: "GET", url: "/api/v1/action-requests?limit=101", headers: { authorization: "Bearer internal" } })).statusCode).toBe(400);
});

const hash = "a".repeat(64);
const decision = { payloadHash: hash, reason: "Reviewed the exact payload" };
function approver() {
  const f = fixture();
  f.user.sub = "synthetic-manager"; f.user.roles = ["fieldloop.manager"]; f.user.authTime = new Date();
  const inject = (url: string, payload: unknown, headers: Record<string, string> = f.headers) =>
    f.app.inject({ method: "POST", url, payload: JSON.stringify(payload), headers: { "content-type": "application/json", ...headers } });
  return { ...f, inject, approvals: `/api/v1/action-requests/${f.action.id}/approvals`, reject: `/api/v1/action-requests/${f.action.id}:reject` };
}
it("approves the exact payload with a cookie session, CSRF, idempotency and a forced fresh introspection", async () => {
  const { actions, auth, inject, approvals, headers, user, action, decided } = approver();
  const result = await inject(approvals, decision);
  expect(result.statusCode).toBe(201); expect(result.json()).toEqual(decided);
  expect(result.headers["cache-control"]).toBe("private, no-store");
  expect(actions.decide).toHaveBeenCalledWith(user, action.id, "approved", decision, headers["idempotency-key"]);
  expect(auth.getCurrentUser).toHaveBeenCalledWith("valid", true);
});
it("rejects with a reason through the same gate and returns 200", async () => {
  const { actions, inject, reject, headers, user, action } = approver();
  const result = await inject(reject, decision);
  expect(result.statusCode).toBe(200);
  expect(actions.decide).toHaveBeenCalledWith(user, action.id, "rejected", decision, headers["idempotency-key"]);
});
it("requires a login under 5 minutes old before the service is reached", async () => {
  const { actions, inject, approvals, reject, user } = approver();
  for (const authTime of [new Date(Date.now() - APPROVAL_MAX_AUTH_AGE_MS - 1000), new Date(0)]) {
    user.authTime = authTime;
    for (const url of [approvals, reject]) {
      const stale = await inject(url, decision);
      expect(stale.statusCode).toBe(403); expect(stale.json()).toMatchObject({ code: "reauthentication_required" });
    }
  }
  expect(actions.decide).not.toHaveBeenCalled();
});
it("keeps the BFF gate and the service agreeing on how old a login may be", () => {
  const now = new Date();
  expect(isRecentAuthTime(new Date(now.getTime() - APPROVAL_MAX_AUTH_AGE_MS + 1), now)).toBe(true);
  expect(isRecentAuthTime(new Date(now.getTime() - APPROVAL_MAX_AUTH_AGE_MS), now)).toBe(false);
});
it("refuses unauthenticated, CSRF-less, non-manager and malformed decisions before storage", async () => {
  const { actions, inject, approvals, reject, headers, user } = approver();
  for (const url of [approvals, reject]) {
    expect((await inject(url, decision, {})).statusCode).toBe(401);
    expect((await inject(url, decision, { cookie: headers.cookie })).statusCode).toBe(403);
    for (const roles of [["fieldloop.operator"], ["fieldloop.viewer"]]) {
      user.roles = roles; expect((await inject(url, decision, headers)).statusCode).toBe(403);
    }
    user.roles = ["fieldloop.manager"];
    for (const bad of [{}, { reason: "x" }, { ...decision, reason: "  " }, { ...decision, payloadHash: "abc" }, { ...decision, approverSub: "spoofed" }, { ...decision, status: "approved" }]) {
      expect((await inject(url, bad, headers)).statusCode).toBe(400);
    }
    expect((await inject(url, decision, { ...headers, "idempotency-key": "short" })).statusCode).toBe(400);
  }
  expect((await inject("/api/v1/action-requests/not-a-uuid/approvals", decision)).statusCode).toBe(400);
  expect(actions.decide).not.toHaveBeenCalled();
});
it("never accepts the internal Bearer token as an Approver (an AI subject cannot approve)", async () => {
  const { app, actions, auth, user, approvals, reject } = approver();
  Object.assign(auth, { getCurrentUserFromInternalToken: vi.fn().mockResolvedValue({ ...user, csrfToken: "", authTime: new Date(0) }) });
  for (const url of [approvals, reject]) {
    const result = await app.inject({ method: "POST", url, payload: JSON.stringify(decision),
      headers: { "content-type": "application/json", authorization: "Bearer synthetic-internal-token", "idempotency-key": "synthetic-bearer-key" } });
    expect(result.statusCode).toBe(401);
  }
  expect(auth.getCurrentUserFromInternalToken).not.toHaveBeenCalled();
  expect(actions.decide).not.toHaveBeenCalled();
});
it("returns decision conflicts and failures as RFC 9457 without leaking storage detail", async () => {
  const { actions, inject, approvals } = approver();
  for (const code of ["payload_changed", "four_eyes_required", "request_expired"]) {
    vi.mocked(actions.decide).mockRejectedValueOnce(new ActionError(code === "four_eyes_required" ? 403 : 409, code));
    const result = await inject(approvals, decision);
    expect(result.headers["content-type"]).toContain("application/problem+json"); expect(result.json()).toMatchObject({ code });
  }
  vi.mocked(actions.decide).mockRejectedValueOnce(new Error("secret database detail"));
  const failed = await inject(approvals, decision);
  expect(failed.statusCode).toBe(503); expect(failed.body).not.toContain("secret database detail");
});
