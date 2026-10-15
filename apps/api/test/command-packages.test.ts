import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { CommandPackageError, type CommandPackage, type CommandPackageServicePort } from "@fieldloop/adapters";
import { buildApp } from "../src/app.js";
import { AuthError, type AuthServicePort, type CurrentUser } from "../src/auth/service.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function fixture() {
  const user: CurrentUser = { sub: "synthetic-operator", roles: ["fieldloop.operator"], persona: "Control-room Operator",
    orgId: "synthetic-org", clearance: "HIGHLY_RESTRICTED", csrfToken: "synthetic-csrf", authTime: new Date() };
  const auth: AuthServicePort = {
    getCurrentUser: async (cookie) => { if (cookie !== "valid") throw new AuthError("Session required", 401); return user; },
    startLogin: async () => new URL("https://example.test"), startReauthentication: async () => new URL("https://example.test"),
    completeLogin: async () => { throw new Error("unused"); }, issueInternalUserToken: async () => { throw new Error("unused"); },
    logout: async () => new URL("https://example.test"), backchannelLogout: async () => {}, jwks: async () => ({ keys: [] }),
  };
  const commandPackage: CommandPackage = {
    id: randomUUID(), actionRequestId: randomUUID(), target: "SYNTHETIC-PUMP-3", action: "Deploy mobile pump",
    rationale: "Reduce simulated flood exposure", citations: ["synthetic:procedure-7"], procedure: "PROC-SYN-7",
    preconditions: ["Pump disconnected from live grid"], barrierId: randomUUID(), expectedEffect: "Reduce standing water at the synthetic hospital access route.", approvalCount: 2, actionStatus: "approved",
    executionStatus: "queued", outcome: null, evidenceId: null, recordedBy: null, recordedAt: null,
    simulated: true, classification: "INTERNAL", createdAt: "2026-10-15T00:00:00.000Z", expiresAt: "2026-10-15T00:15:00.000Z",
  };
  const commandPackages: CommandPackageServicePort = {
    list: vi.fn().mockImplementation(async (_user, _status, _cursor, limit) => ({ items: [commandPackage], limit, nextCursor: null })),
    recordOutcome: vi.fn().mockResolvedValue({ ...commandPackage, executionStatus: "executed", outcome: "Completed in simulation.", evidenceId: randomUUID(), recordedBy: user.sub, recordedAt: "2026-10-15T00:01:00.000Z" }),
  };
  const app = buildApp({ auth, commandPackages }); apps.push(app);
  const headers = { cookie: "fl_session=valid", "x-csrf-token": user.csrfToken, "idempotency-key": "synthetic-command-outcome" };
  return { app, user, commandPackages, commandPackage, headers };
}

it("lists the organisation-scoped Command Package queue with validated filters", async () => {
  const { app, user, commandPackages, commandPackage, headers } = fixture();
  const response = await app.inject({ method: "GET", url: "/api/v1/command-packages?cursor=opaque-cursor&limit=25&status=queued", headers });
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.json()).toEqual({ items: [commandPackage], limit: 25, nextCursor: null });
  expect(commandPackages.list).toHaveBeenCalledWith(user, "queued", "opaque-cursor", 25);
  expect((await app.inject({ method: "GET", url: "/api/v1/command-packages?status=invalid", headers })).statusCode).toBe(400);
  expect((await app.inject({ method: "GET", url: "/api/v1/command-packages?limit=201", headers })).statusCode).toBe(400);
  expect((await app.inject({ method: "GET", url: "/api/v1/command-packages?unexpected=true", headers })).statusCode).toBe(400);
  expect((await app.inject({ method: "GET", url: "/api/v1/command-packages", headers: {} })).statusCode).toBe(401);
});

it("records an operator outcome through the cookie, CSRF and idempotency boundary", async () => {
  const { app, user, commandPackages, commandPackage, headers } = fixture();
  const body = { executionStatus: "executed", outcome: "Completed in simulation." };
  const response = await app.inject({ method: "POST", url: `/api/v1/command-packages/${commandPackage.id}/outcome`, payload: body, headers });
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.json()).toMatchObject({ executionStatus: "executed", outcome: body.outcome, recordedBy: user.sub, evidenceId: expect.any(String) });
  expect(commandPackages.recordOutcome).toHaveBeenCalledWith(user, commandPackage.id, body, headers["idempotency-key"]);
  expect((await app.inject({ method: "POST", url: `/api/v1/command-packages/${commandPackage.id}/outcome`, payload: body, headers: { cookie: headers.cookie } })).statusCode).toBe(403);
  user.roles = ["fieldloop.viewer"];
  expect((await app.inject({ method: "POST", url: `/api/v1/command-packages/${commandPackage.id}/outcome`, payload: body, headers })).statusCode).toBe(403);
  expect(commandPackages.recordOutcome).toHaveBeenCalledTimes(1);
});

it("rejects malformed outcome bodies and returns RFC 9457 conflicts", async () => {
  const { app, commandPackages, commandPackage, headers } = fixture();
  const url = `/api/v1/command-packages/${commandPackage.id}/outcome`;
  for (const body of [
    { executionStatus: "unknown", outcome: "Result" }, { executionStatus: "executed", outcome: "   " },
    { executionStatus: "not_executed", outcome: "Reason", actionRequestId: randomUUID() },
  ]) expect((await app.inject({ method: "POST", url, payload: body, headers })).statusCode).toBe(400);
  expect((await app.inject({ method: "POST", url, payload: { executionStatus: "executed", outcome: "Result" }, headers: { ...headers, "idempotency-key": "short" } })).statusCode).toBe(400);
  vi.mocked(commandPackages.recordOutcome).mockRejectedValueOnce(new CommandPackageError(409, "approval_required"));
  const conflict = await app.inject({ method: "POST", url, payload: { executionStatus: "executed", outcome: "Result" }, headers });
  expect(conflict.statusCode).toBe(409);
  expect(conflict.headers["content-type"]).toContain("application/problem+json");
  expect(conflict.json()).toMatchObject({ status: 409, code: "approval_required" });
});
