import { expect, it } from "vitest";
import { ACTION_CEILINGS, effectiveCeiling, evaluateToolCall } from "../src/action-policy.js";
import type { ToolCallCheck } from "@fieldloop/contracts";
const base: ToolCallCheck = { aiSystem: "demo-uc-1", tool: "create_action_request", target: "cmms", actionType: "system_of_record", actionLevel: "l1", simulated: true, classification: "INTERNAL" };
it("implements all six immutable PRD ceilings and only accepts lower Organisation ceilings", () => {
  expect(ACTION_CEILINGS).toEqual({ internal_record: "l2", system_of_record: "l1", field_command: "l1", engineering_approval: "l0", emergency_communication: "l2", external_submission: "l2" });
  expect(effectiveCeiling("internal_record", "l1")).toBe("l1");
  expect(() => effectiveCeiling("system_of_record", "l2")).toThrow("invalid_action_policy");
  expect(() => effectiveCeiling("engineering_approval", "l1")).toThrow("invalid_action_policy");
});
it("converts preparation at L1, holds L2, permits L0 recommendations and blocks above ceiling", () => {
  expect(evaluateToolCall(base, [base.tool]).decision).toBe("convert_l1");
  expect(evaluateToolCall({ ...base, target: "stakeholders", actionType: "emergency_communication", actionLevel: "l2" }, [base.tool]).decision).toBe("hold_l2");
  expect(evaluateToolCall({ ...base, target: "engineering-authority", actionType: "engineering_approval", actionLevel: "l0" }, [base.tool]).decision).toBe("allow");
  expect(evaluateToolCall({ ...base, actionLevel: "l2" }, [base.tool]).decision).toBe("block");
  expect(evaluateToolCall(base, [base.tool], "l0").decision).toBe("block");
  expect(evaluateToolCall({ ...base, target: "scada", actionType: "field_command" }, [base.tool]).decision).toBe("convert_l1");
});
it("never executes writes even if someone registers a dangerous tool or spoofs its action", () => {
  for (const tool of ["write_cmms", "write_gis", "set_valve", "approve_action", "execute_command"]) {
    expect(evaluateToolCall({ ...base, tool }, [tool]).decision).toBe("block");
  }
  expect(evaluateToolCall(base, []).decision).toBe("block");
  expect(evaluateToolCall({ ...base, actionType: "internal_record" }, [base.tool]).decision).toBe("block");
  expect(evaluateToolCall({ ...base, tool: "get_asset" }, ["get_asset"]).decision).toBe("block");
  expect(evaluateToolCall({ aiSystem: base.aiSystem, tool: "get_asset", target: "fieldloop", simulated: true, classification: "INTERNAL" }, ["get_asset"]).decision).toBe("allow");
});
