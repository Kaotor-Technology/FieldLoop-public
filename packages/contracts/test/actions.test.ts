import { describe, expect, it } from "vitest";
import { isActionDecisionCreate, isActionRequestCreate, isToolCallCheck, isToolCallDecision } from "../src/actions.js";
const input = { actionType: "system_of_record", actionLevel: "l1", target: "cmms", payload: { title: "Synthetic work order" },
  rationale: "Prepare for the operator", citations: ["synthetic:procedure-1"], simulated: true, classification: "INTERNAL" };
describe("Action contracts", () => {
  it("accepts a complete exact-payload proposal and a read check", () => {
    expect(isActionRequestCreate(input)).toBe(true);
    expect(isToolCallCheck({ aiSystem: "demo-uc-1", tool: "get_asset", target: "fieldloop", simulated: true, classification: "INTERNAL" })).toBe(true);
  });
  it("rejects L3 and caller-controlled hashes, status, identity or Organisation", () => {
    expect(isActionRequestCreate({ ...input, actionLevel: "l3" })).toBe(false);
    for (const key of ["payloadHash", "status", "requestedBy", "requester", "orgId"]) expect(isActionRequestCreate({ ...input, [key]: "spoofed" })).toBe(false);
    expect(isToolCallCheck({ ...input, aiSystem: "demo-uc-1", tool: "create_action_request", actionLevel: "l3" })).toBe(false);
  });
  it("requires meaningful rationale and citations", () => {
    expect(isActionRequestCreate({ ...input, rationale: "   " })).toBe(false);
    expect(isActionRequestCreate({ ...input, citations: [" "] })).toBe(false);
    expect(isActionRequestCreate({ ...input, citations: [] })).toBe(false);
  });
  it("binds a decision to the exact payload hash and a reason", () => {
    const decision = { payloadHash: "a".repeat(64), reason: "Reviewed the payload" };
    expect(isActionDecisionCreate(decision)).toBe(true);
    for (const bad of [{ reason: "x" }, { payloadHash: "a".repeat(64) }, { ...decision, reason: "   " },
      { ...decision, payloadHash: "A".repeat(64) }, { ...decision, payloadHash: "abc" }]) {
      expect(isActionDecisionCreate(bad)).toBe(false);
    }
  });
  it("rejects caller-controlled approver, status and timing on a decision", () => {
    const decision = { payloadHash: "a".repeat(64), reason: "Reviewed the payload" };
    for (const key of ["approverSub", "status", "decision", "authTime", "orgId"]) expect(isActionDecisionCreate({ ...decision, [key]: "spoofed" })).toBe(false);
  });
  it("rejects invalid expiry, simulation IDs and external URL targets", () => {
    expect(isActionRequestCreate({ ...input, expiresAt: "tomorrow" })).toBe(false);
    expect(isActionRequestCreate({ ...input, simulationRunId: "another-run" })).toBe(false);
    expect(isActionRequestCreate({ ...input, target: "https://example.test/write" })).toBe(false);
  });
  it("accepts the Guardrail policy identifier on a Tool Call Decision", () => {
    expect(isToolCallDecision({
      decision: "convert_l1", reason: "human_action_required",
      policyId: "22222222-2222-4333-8444-555555555555",
    })).toBe(true);
    expect(isToolCallDecision({ decision: "block", reason: "blocked", policyId: "not-a-uuid" })).toBe(false);
  });
});
