import { expect, it } from "vitest";
import { ACTION_CEILINGS, effectiveCeiling, evaluateToolCall } from "../src/action-policy.js";
import { actionSchema, type ToolCallCheck } from "@fieldloop/contracts";
const base: ToolCallCheck = { aiSystem: "demo-uc-1", tool: "create_action_request", target: "cmms", actionType: "system_of_record", actionLevel: "l1", simulated: true, classification: "INTERNAL" };
const everyTarget = actionSchema.$defs.ActionTarget.enum;
const registered = (tools: string[], targets: readonly string[] = everyTarget) => ({ tools, targets });
it("implements all six immutable PRD ceilings and only accepts lower Organisation ceilings", () => {
  expect(ACTION_CEILINGS).toEqual({ internal_record: "l2", system_of_record: "l1", field_command: "l1", engineering_approval: "l0", emergency_communication: "l2", external_submission: "l2" });
  expect(effectiveCeiling("internal_record", "l1")).toBe("l1");
  expect(() => effectiveCeiling("system_of_record", "l2")).toThrow("invalid_action_policy");
  expect(() => effectiveCeiling("engineering_approval", "l1")).toThrow("invalid_action_policy");
});
it("converts preparation at L1, holds L2, permits L0 recommendations and blocks above ceiling", () => {
  expect(evaluateToolCall(base, registered([base.tool])).decision).toBe("convert_l1");
  expect(evaluateToolCall({ ...base, target: "stakeholders", actionType: "emergency_communication", actionLevel: "l2" }, registered([base.tool])).decision).toBe("hold_l2");
  expect(evaluateToolCall({ ...base, target: "engineering-authority", actionType: "engineering_approval", actionLevel: "l0" }, registered([base.tool])).decision).toBe("allow");
  expect(evaluateToolCall({ ...base, actionLevel: "l2" }, registered([base.tool])).decision).toBe("block");
  expect(evaluateToolCall(base, registered([base.tool]), "l0").decision).toBe("block");
  expect(evaluateToolCall({ ...base, target: "scada", actionType: "field_command" }, registered([base.tool])).decision).toBe("convert_l1");
});
it("treats Geo Reference extraction as an L0 internal Draft proposal", () => {
  const proposal: ToolCallCheck = {
    ...base, tool: "extract_geo_references", target: "fieldloop",
    actionType: "internal_record", actionLevel: "l0",
  };
  expect(evaluateToolCall(proposal, registered([proposal.tool])))
    .toEqual({ decision: "allow", reason: "recommendation_only", ceiling: "l2" });
  expect(evaluateToolCall({ ...proposal, actionLevel: "l1" }, registered([proposal.tool])).decision)
    .toBe("block");
  expect(evaluateToolCall({ ...proposal, actionType: "system_of_record", target: "gis" }, registered([proposal.tool])).decision)
    .toBe("block");
  const unclassified: ToolCallCheck = { ...proposal };
  delete unclassified.actionType;
  delete unclassified.actionLevel;
  expect(evaluateToolCall(unclassified, registered([proposal.tool])).decision).toBe("block");
});
it("never executes writes even if someone registers a dangerous tool or spoofs its action", () => {
  for (const tool of ["write_cmms", "write_gis", "set_valve", "approve_action", "execute_command"]) {
    expect(evaluateToolCall({ ...base, tool }, registered([tool])).decision).toBe("block");
  }
  expect(evaluateToolCall(base, registered([])).decision).toBe("block");
  expect(evaluateToolCall({ ...base, actionType: "internal_record" }, registered([base.tool])).decision).toBe("block");
  expect(evaluateToolCall({ ...base, tool: "get_asset" }, registered(["get_asset"])).decision).toBe("block");
  expect(evaluateToolCall({ aiSystem: base.aiSystem, tool: "get_asset", target: "fieldloop", simulated: true, classification: "INTERNAL" }, registered(["get_asset"])).decision).toBe("allow");
});
it("blocks targets outside the AI System allowlist before any proposal (PRD GR-4)", () => {
  const systemsOfRecord = ["fieldloop", "cmms", "integrity-database", "gis", "asset-register", "siem", "historian"];
  expect(evaluateToolCall(base, registered([base.tool], systemsOfRecord)).decision).toBe("convert_l1");
  expect(evaluateToolCall({ ...base, target: "scada", actionType: "field_command" }, registered([base.tool], systemsOfRecord)))
    .toEqual({ decision: "block", reason: "target_not_registered" });
  expect(evaluateToolCall({ ...base, target: "stakeholders", actionType: "emergency_communication", actionLevel: "l2" }, registered([base.tool], systemsOfRecord)).decision).toBe("block");
  expect(evaluateToolCall({ aiSystem: base.aiSystem, tool: "get_asset", target: "fieldloop", simulated: true, classification: "INTERNAL" }, registered(["get_asset"], ["cmms"])))
    .toEqual({ decision: "block", reason: "target_not_registered" });
});

it("converts only an explicitly registered CMMS work-order operation into fixed L1 preparation", () => {
  const alias = { ...base, tool: "cmms.create_work_order" };
  const registration = registered([alias.tool]);
  expect(evaluateToolCall(alias, registration)).toEqual({ decision: "convert_l1", reason: "human_action_required", ceiling: "l1" });
  expect(evaluateToolCall(alias, registered([base.tool])).decision).toBe("block");
  expect(evaluateToolCall(alias, registration, "l0").decision).toBe("block");
  const missingType = { ...alias };
  delete missingType.actionType;
  for (const input of [
    { ...alias, actionLevel: "l0" as const },
    { ...alias, actionLevel: "l2" as const },
    { ...alias, target: "gis" as const },
    { ...alias, target: "fieldloop" as const, actionType: "internal_record" as const },
    missingType,
    { ...alias, tool: "cmms.delete_work_order" },
  ]) expect(evaluateToolCall(input, registered([input.tool])).decision).toBe("block");
});
