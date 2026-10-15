import { describe, expect, it } from "vitest";
import { isActionDecisionCreate, isActionRequestCreate, isToolCallCheck } from "../src/actions.js";
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
  it("requires a complete non-commanding L1 package for field commands", () => {
    const command = {
      ...input,
      actionType: "field_command",
      actionLevel: "l1",
      target: "ot",
      payload: {
        target: "SYNTHETIC-PUMP-3",
        action: "Deploy the mobile pump",
        procedure: "PROC-SYN-7",
        barrierId: "00000000-0000-4000-8000-000000000001",
        preconditions: ["Pump disconnected from live grid"],
      },
    };
    expect(isActionRequestCreate(command)).toBe(true);
    expect(isActionRequestCreate({ ...command, actionLevel: "l2" })).toBe(false);
    expect(isActionRequestCreate({ ...command, target: "cmms" })).toBe(false);
    for (const key of ["target", "action", "procedure", "barrierId", "preconditions"]) {
      const payload = Object.fromEntries(Object.entries(command.payload).filter(([candidate]) => candidate !== key));
      expect(isActionRequestCreate({ ...command, payload })).toBe(false);
    }
    expect(isToolCallCheck({
      aiSystem: "demo-uc-1", tool: "create_action_request", actionType: "field_command", actionLevel: "l1",
      target: "ot", payload: command.payload, rationale: command.rationale, citations: command.citations,
      simulated: true, classification: "INTERNAL",
    })).toBe(true);
    expect(isToolCallCheck({
      aiSystem: "demo-uc-1", tool: "create_action_request", actionType: "field_command", actionLevel: "l1",
      target: "ot", simulated: true, classification: "INTERNAL",
    })).toBe(false);
  });
});
