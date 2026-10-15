import { describe, expect, it } from "vitest";
import { isActionRequestCreate, isToolCallCheck } from "../src/actions.js";
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
  it("rejects invalid expiry, simulation IDs and external URL targets", () => {
    expect(isActionRequestCreate({ ...input, expiresAt: "tomorrow" })).toBe(false);
    expect(isActionRequestCreate({ ...input, simulationRunId: "another-run" })).toBe(false);
    expect(isActionRequestCreate({ ...input, target: "https://example.test/write" })).toBe(false);
  });
});
