import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api-client";
import {
  ActionDecisionError, createIdempotencyKeys, decideActionRequest, decisionBlock, failureKind, formatCountdown, isLoginFresh,
  reauthDestination, type ActionRequest,
} from "./action-approval";

afterEach(() => { vi.restoreAllMocks(); });

const hash = "a".repeat(64);
const action = (overrides: Partial<ActionRequest> = {}): ActionRequest => ({
  id: "96000000-0000-4000-8000-000000000001", orgId: "synthetic-org", actionType: "emergency_communication", actionLevel: "l2", target: "stakeholders",
  payload: { scenario: "storm-b", message: "SIMULATION drill" }, payloadHash: hash, rationale: "Drill rationale", citations: ["synthetic:plan-1"],
  requestedBy: "synthetic-operator", requester: { kind: "person" }, status: "open", expiresAt: "2026-10-15T10:15:00.000Z", simulated: true,
  classification: "INTERNAL", ...overrides,
});
const manager = { sub: "synthetic-manager", roles: ["fieldloop.manager"] };
const now = Date.parse("2026-10-15T10:00:00.000Z");

describe("approval gating helpers", () => {
  it("asks for a new login before the server's 5-minute window can run out", () => {
    const at = (ms: number) => new Date(now - ms).toISOString();
    expect(isLoginFresh(at(60_000), now)).toBe(true);
    expect(isLoginFresh(at(4 * 60_000 + 29_000), now)).toBe(true);
    expect(isLoginFresh(at(4 * 60_000 + 31_000), now)).toBe(false);
    expect(isLoginFresh(at(10 * 60_000), now)).toBe(false);
    expect(isLoginFresh(at(-60_000), now)).toBe(false);
  });
  it("counts the SLA down in mono mm:ss and stops at zero", () => {
    expect(formatCountdown("2026-10-15T10:01:05.000Z", now)).toBe("01:05");
    expect(formatCountdown("2026-10-15T09:59:00.000Z", now)).toBe("00:00");
  });
  it("blocks the decision for non-managers, the requester, closed and expired requests", () => {
    expect(decisionBlock(action(), manager, now)).toBeNull();
    expect(decisionBlock(action(), { sub: "synthetic-operator", roles: ["fieldloop.operator"] }, now)).toBe("role");
    expect(decisionBlock(action(), { sub: "synthetic-operator", roles: ["fieldloop.manager"] }, now)).toBe("four_eyes");
    expect(decisionBlock(action({ status: "approved" }), manager, now)).toBe("closed");
    expect(decisionBlock(action({ status: "rejected" }), manager, now)).toBe("closed");
    expect(decisionBlock(action({ expiresAt: "2026-10-15T09:59:59.000Z" }), manager, now)).toBe("expired");
  });
  it("reuses one Idempotency-Key for a retry of the same decision and a new one when anything changes", () => {
    let counter = 0;
    const next = createIdempotencyKeys(() => `key-${++counter}`);
    const input = { actionRequestId: "id-1", decision: "approve" as const, payloadHash: hash, reason: "Reviewed" };
    expect(next(input)).toBe("key-1");
    expect(next({ ...input })).toBe("key-1");
    expect(next({ ...input, reason: "Reviewed again" })).toBe("key-2");
    expect(next({ ...input, reason: "Reviewed again", decision: "reject" })).toBe("key-3");
    expect(next({ ...input, reason: "Reviewed again", decision: "reject", payloadHash: "b".repeat(64) })).toBe("key-4");
  });
  it("returns to the request after the forced re-login and never leaves the origin", () => {
    expect(reauthDestination("/actions/abc?review=1")).toBe("/api/auth/reauth?return=%2Factions%2Fabc%3Freview%3D1");
  });
  it("maps server problem codes to a known failure and everything else to unavailable", () => {
    expect(failureKind(new ActionDecisionError(409, "payload_changed"))).toBe("payload_changed");
    expect(failureKind(new ActionDecisionError(403, "reauthentication_required"))).toBe("reauthentication_required");
    expect(failureKind(new ActionDecisionError(500, "secret_detail"))).toBe("unavailable");
    expect(failureKind(new Error("network"))).toBe("unavailable");
  });
});

describe("decision requests", () => {
  const input = { actionRequestId: "96000000-0000-4000-8000-000000000001", payloadHash: hash, reason: "Reviewed the exact payload", idempotencyKey: "synthetic-key-0001", csrfToken: "synthetic-csrf" };
  const result = { actionRequest: action({ status: "approved" }), approval: { id: "x" } };
  it("approves the payload hash the Approver saw with CSRF and an Idempotency-Key", async () => {
    const post = vi.spyOn(api, "POST").mockResolvedValue({ data: result, response: new Response(null, { status: 201 }) } as never);
    await expect(decideActionRequest({ ...input, decision: "approve" })).resolves.toBe(result);
    expect(post).toHaveBeenCalledWith("/v1/action-requests/{actionRequestId}/approvals", {
      params: { path: { actionRequestId: input.actionRequestId }, header: { "X-CSRF-Token": "synthetic-csrf", "Idempotency-Key": "synthetic-key-0001" } },
      body: { payloadHash: hash, reason: "Reviewed the exact payload" },
    });
  });
  it("rejects through the reject command with the same exact-payload body", async () => {
    const post = vi.spyOn(api, "POST").mockResolvedValue({ data: result, response: new Response(null, { status: 200 }) } as never);
    await decideActionRequest({ ...input, decision: "reject" });
    expect(post.mock.calls[0]?.[0]).toBe("/v1/action-requests/{actionRequestId}:reject");
  });
  it("throws the server's problem code and never a stored result", async () => {
    vi.spyOn(api, "POST").mockResolvedValue({ error: { code: "payload_changed" }, response: new Response(null, { status: 409 }) } as never);
    await expect(decideActionRequest({ ...input, decision: "approve" })).rejects.toMatchObject({ status: 409, code: "payload_changed" });
  });
});
