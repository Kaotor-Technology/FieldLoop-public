import type { AgentTurn } from "./agent-chat-store";

export type GuardrailNoticeKind = "converted" | "held" | "blocked" | "redacted" | "rerouted" | "allowed";

const actionRequestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeActionRequestIds(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !actionRequestIdPattern.test(value)) continue;
    const normalized = value.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    ids.push(value);
  }
  return ids;
}

export function actionRequestIdsForTurn(turn: AgentTurn): string[] {
  const ids = [...(turn.answer?.actionRequestIds ?? [])];
  for (const step of turn.steps) {
    if (step.name !== "guardrail.decision") continue;
    const id = readString(step.data["action_request_id"]) ?? readString(step.data["actionRequestId"]);
    if (id) ids.push(id);
  }
  return normalizeActionRequestIds(ids);
}

export function guardrailNoticeKind(value: unknown): GuardrailNoticeKind | undefined {
  if (typeof value !== "string") return undefined;
  const decision = value.toLowerCase().replace(/[\s-]+/g, "_");
  if (["convert_l1", "converted", "converted_to_l1", "action_request_created"].includes(decision)) return "converted";
  if (["hold", "hold_l2", "held", "held_for_review"].includes(decision)) return "held";
  if (["block", "blocked"].includes(decision)) return "blocked";
  if (["redact", "redacted"].includes(decision)) return "redacted";
  if (["reroute", "rerouted", "route"].includes(decision)) return "rerouted";
  if (decision === "allow" || decision === "allowed") return "allowed";
  return undefined;
}

export function guardrailNoticeDetails(step: AgentTurn["steps"][number]): { kind: GuardrailNoticeKind; policyId?: string; reason?: string } | undefined {
  if (step.name !== "guardrail.decision") return undefined;
  const kind = guardrailNoticeKind(step.data["decision"] ?? step.data["action"]);
  if (!kind || kind === "allowed") return undefined;
  const policyId = readString(step.data["policyId"]) ?? readString(step.data["policy_id"]);
  const reason = readString(step.data["reason"]) ?? readString(step.data["detail"]) ?? readString(step.data["summary"]);
  return {
    kind,
    ...(policyId ? { policyId } : {}),
    ...(reason ? { reason } : {}),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
