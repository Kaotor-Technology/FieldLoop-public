import { afterEach, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { AuthError, type AuthServicePort, type CurrentUser } from "../src/auth/service.js";
import { DraftServiceError, type DraftItem, type DraftServicePort } from "../src/drafts/model.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function fixture(roles = ["fieldloop.operator"]) {
  const user: CurrentUser = {
    sub: "synthetic-reviewer", displayName: "Synthetic Reviewer", roles, persona: "Integrity Engineer",
    orgId: "synthetic-org", clearance: "INTERNAL", csrfToken: "fixture-csrf", authTime: new Date(),
  };
  const draft: DraftItem = {
    id: "11111111-2222-4333-8444-555555555555", kind: "management_summary", content: "Summary: [4](/api/v1/bowties/11111111-2222-4333-8444-555555555555/risk)",
    citations: ["/api/v1/bowties/11111111-2222-4333-8444-555555555555/risk"], confidence: 0.8, status: "needs_approval",
    approvedBy: null, approvedAt: null, approvalStamp: null, decisionBy: null, decisionAt: null, decisionReason: null,
    simulated: true, classification: "INTERNAL", createdAt: "2026-10-15T00:00:00.000Z", createdBy: "agent:report-generator on_behalf_of:synthetic-author",
  };
  const auth: AuthServicePort = {
    getCurrentUser: async (cookie) => { if (cookie !== "valid") throw new AuthError("Session required", 401); return user; },
    getCurrentUserFromInternalToken: async () => user,
    startLogin: async () => new URL("https://example.test"), startReauthentication: async () => new URL("https://example.test"),
    completeLogin: async () => { throw new Error("unused"); }, issueInternalUserToken: async () => "unused",
    logout: async () => new URL("https://example.test"), backchannelLogout: async () => {}, jwks: async () => ({ keys: [] }),
  };
  const store: DraftServicePort = {
    list: vi.fn(async (...args: Parameters<DraftServicePort["list"]>) => { void args; return [draft]; }),
    get: vi.fn(async (_user, id) => { if (id !== draft.id) throw new DraftServiceError(404, "not_found"); return draft; }),
    decide: vi.fn(async (input) => {
      if (input.user.sub === "synthetic-author") throw new DraftServiceError(403, "author_cannot_approve");
      const status: DraftItem["status"] = input.decision === "approve" ? "approved" : "rejected";
      return { ...draft, status, approvedBy: status === "approved" ? input.user.displayName ?? null : null,
        approvedAt: status === "approved" ? "2026-10-15T09:20:00.000Z" : null,
        approvalStamp: status === "approved" ? "AI-assisted, approved by Synthetic Reviewer, 2026-10-15" : null,
        decisionBy: input.user.displayName ?? null, decisionAt: "2026-10-15T09:20:00.000Z",
        decisionReason: input.reason ?? null };
    }),
  };
  const app = buildApp({ auth, drafts: store });
  apps.push(app);
  const headers = { cookie: "fl_session=valid", "x-csrf-token": user.csrfToken, "idempotency-key": "draft-decision-key-001" };
  return { app, store, user, draft, headers };
}

it("lists and reads management summary Drafts through the signed-in BFF session", async () => {
  const { app, store, user, draft } = fixture();
  const response = await app.inject({ method: "GET", url: "/api/v1/drafts?status=needs_approval&limit=25", cookies: { fl_session: "valid" } });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual([draft]);
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(store.list).toHaveBeenCalledWith(user, "needs_approval", 25);
  expect((await app.inject({ method: "GET", url: `/api/v1/drafts/${draft.id}`, cookies: { fl_session: "valid" } })).json()).toEqual(draft);
  expect((await app.inject({ method: "GET", url: "/api/v1/drafts?status=all", cookies: { fl_session: "valid" } })).statusCode).toBe(400);
});

it("approves a Draft and returns the exact human approval stamp", async () => {
  const { app, store, user, draft, headers } = fixture();
  const response = await app.inject({ method: "POST", url: `/api/v1/drafts/${draft.id}:approve`, headers, payload: {} });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ status: "approved", approvalStamp: "AI-assisted, approved by Synthetic Reviewer, 2026-10-15" });
  expect(store.decide).toHaveBeenCalledWith({ user, draftId: draft.id, decision: "approve", idempotencyKey: headers["idempotency-key"] });
});

it("requires reauthentication, CSRF, an Operator or Manager and a reason for rejection", async () => {
  const { app, draft, headers, store } = fixture(["fieldloop.viewer"]);
  const url = `/api/v1/drafts/${draft.id}:approve`;
  expect((await app.inject({ method: "POST", url, headers, payload: {} })).statusCode).toBe(403);
  expect(store.decide).not.toHaveBeenCalled();

  const authorized = fixture();
  expect((await authorized.app.inject({ method: "POST", url, cookies: { fl_session: "valid" }, payload: {} })).statusCode).toBe(403);
  authorized.user.authTime = new Date(Date.now() - 6 * 60 * 1000);
  expect((await authorized.app.inject({ method: "POST", url, headers: authorized.headers, payload: {} })).statusCode).toBe(403);
  expect(authorized.store.decide).not.toHaveBeenCalled();

  authorized.user.authTime = new Date();
  const reject = await authorized.app.inject({ method: "POST", url: `/api/v1/drafts/${draft.id}:reject`, headers: authorized.headers, payload: {} });
  expect(reject.statusCode).toBe(400);
  expect((await authorized.app.inject({ method: "POST", url: `/api/v1/drafts/${draft.id}:reject`, headers: authorized.headers, payload: { reason: "Needs source context" } })).statusCode).toBe(200);
});

it("does not accept an internal bearer token for Draft decisions and maps four-eyes conflicts", async () => {
  const { app, user, draft, headers, store } = fixture();
  expect((await app.inject({ method: "POST", url: `/api/v1/drafts/${draft.id}:approve`, headers: { authorization: "Bearer internal" }, payload: {} })).statusCode).toBe(401);
  user.sub = "synthetic-author";
  const selfApproval = await app.inject({ method: "POST", url: `/api/v1/drafts/${draft.id}:approve`, headers, payload: {} });
  expect(selfApproval.statusCode).toBe(403);
  expect(selfApproval.json().code).toBe("author_cannot_approve");
  expect(store.decide).toHaveBeenCalledTimes(1);
});
