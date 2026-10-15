import type { ActionLevel, ActionType, ActionTarget, ToolCallCheck, ToolCallDecision } from "@fieldloop/contracts";

export const ACTION_CEILINGS: Readonly<Record<ActionType, ActionLevel>> = {
  internal_record: "l2", system_of_record: "l1", field_command: "l1",
  engineering_approval: "l0", emergency_communication: "l2", external_submission: "l2",
};
const targets: Readonly<Record<ActionType, readonly ActionTarget[]>> = {
  internal_record: ["fieldloop"], system_of_record: ["cmms", "integrity-database", "gis", "asset-register", "siem", "historian"],
  field_command: ["scada", "ot"], engineering_approval: ["engineering-authority"],
  emergency_communication: ["stakeholders"], external_submission: ["regulator", "external-party"],
};
const reads = new Set(["search_knowledge", "get_document", "get_asset", "get_barriers", "get_bowtie_risk",
  "get_action_requests", "get_stakeholders", "spatial_query", "get_scenario_state"]);
const draftTools = new Set(["create_draft", "extract_geo_references"]);
export const levelRank = (level: ActionLevel): number => ["l0", "l1", "l2"].indexOf(level);
export function targetMatches(type: ActionType, target: ActionTarget): boolean { return targets[type].includes(target); }
export function effectiveCeiling(type: ActionType, lowered?: ActionLevel): ActionLevel {
  const platform = ACTION_CEILINGS[type];
  if (lowered !== undefined && (levelRank(lowered) < 0 || levelRank(lowered) > levelRank(platform))) {
    throw new ActionError(503, "invalid_action_policy");
  }
  return lowered ?? platform;
}
/** An AI System's registered tools and targets after intersecting with its tool-call policy (PRD GR-4). */
export interface ToolRegistration { tools: readonly string[]; targets: readonly string[] }
export class ActionError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); this.name = "ActionError"; }
}
export function evaluateToolCall(input: ToolCallCheck, registered: ToolRegistration, lowered?: ActionLevel): ToolCallDecision {
  if (!registered.tools.includes(input.tool)) return { decision: "block", reason: "tool_not_registered" };
  if (!registered.targets.includes(input.target)) return { decision: "block", reason: "target_not_registered" };
  if (reads.has(input.tool)) {
    return input.target === "fieldloop" && input.actionType === undefined && input.actionLevel === undefined
      ? { decision: "allow", reason: "registered_read" }
      : { decision: "block", reason: "read_target_or_action_mismatch" };
  }
  // Never infer execution capability from a caller's tool name, URL or claimed action type.
  if (input.tool !== "create_action_request" && !draftTools.has(input.tool)) {
    return { decision: "block", reason: "tool_has_no_safe_implementation" };
  }
  const { actionType, actionLevel, target } = input;
  if (!actionType || !actionLevel || !targetMatches(actionType, target)
    || (draftTools.has(input.tool) && (actionType !== "internal_record" || actionLevel !== "l0"))) {
    return { decision: "block", reason: "action_target_mismatch" };
  }
  const ceiling = effectiveCeiling(actionType, lowered);
  if (levelRank(actionLevel) > levelRank(ceiling)) return { decision: "block", reason: "above_action_ceiling", ceiling };
  if (actionLevel === "l0") return { decision: "allow", reason: "recommendation_only", ceiling };
  return { decision: actionLevel === "l1" ? "convert_l1" : "hold_l2", reason: "human_action_required", ceiling };
}
