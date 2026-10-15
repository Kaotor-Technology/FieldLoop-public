import type { components } from "@fieldloop/contracts";
import { api, type CurrentUser } from "./api-client";

export type ActionRequest = components["schemas"]["ActionRequest"];
export type ActionDecisionResult = components["schemas"]["ActionDecisionResult"];
export type ActionType = ActionRequest["actionType"];
export type ActionDecision = "approve" | "reject";
export type DecisionBlock = "role" | "four_eyes" | "closed" | "expired" | null;

export const actionRequestQueryKey = (id?: string) => id
  ? ["action-request", id] as const
  : ["action-request"] as const;

// The server accepts a decision only within 5 minutes of the login (architecture §4.3) and stays authoritative.
// The dialog asks for a new login a little earlier so a slow reader is not refused on the final click.
const LOGIN_MAX_AGE_MS = 5 * 60_000;
const LOGIN_SAFETY_MS = 30_000;
const CLOCK_SKEW_MS = 30_000;

export function isLoginFresh(authTime: string, now: number): boolean {
  const age = now - Date.parse(authTime);
  return age >= -CLOCK_SKEW_MS && age < LOGIN_MAX_AGE_MS - LOGIN_SAFETY_MS;
}

// PRD §7.5 Q37 and Q61: these action types need a second Approver. The working two-person rule is Phase 1,
// so the demo shows a labelled mock step and records one real Approval.
const SECOND_APPROVAL_TYPES: ReadonlySet<ActionType> = new Set(["emergency_communication", "external_submission", "field_command"]);
export const needsSecondApproval = (type: ActionType): boolean => SECOND_APPROVAL_TYPES.has(type);

export function formatCountdown(expiresAt: string, now: number): string {
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function decisionBlock(action: ActionRequest, user: Pick<CurrentUser, "sub"> & { roles: readonly string[] }, now: number): DecisionBlock {
  if (!user.roles.includes("fieldloop.manager")) return "role";
  if (action.status === "open" || action.status === "in_review") {
    if (Date.parse(action.expiresAt) <= now) return "expired";
    return action.requestedBy === user.sub ? "four_eyes" : null;
  }
  return "closed";
}

export class ActionDecisionError extends Error {
  constructor(readonly status: number, readonly code: string) { super("Action decision failed"); }
}

export async function getActionRequest(id: string, signal: AbortSignal): Promise<ActionRequest> {
  const { data, response } = await api.GET("/v1/action-requests/{actionRequestId}", { params: { path: { actionRequestId: id } }, signal });
  if (!response.ok || !data) throw new ActionDecisionError(response.status, "unavailable");
  return data;
}

export interface DecisionInput {
  actionRequestId: string;
  decision: ActionDecision;
  payloadHash: string;
  reason: string;
  idempotencyKey: string;
  csrfToken: string;
}

export async function decideActionRequest(input: DecisionInput): Promise<ActionDecisionResult> {
  const params = {
    path: { actionRequestId: input.actionRequestId },
    header: { "X-CSRF-Token": input.csrfToken, "Idempotency-Key": input.idempotencyKey },
  };
  const body = { payloadHash: input.payloadHash, reason: input.reason };
  const result = input.decision === "approve"
    ? await api.POST("/v1/action-requests/{actionRequestId}/approvals", { params, body })
    : await api.POST("/v1/action-requests/{actionRequestId}:reject", { params, body });
  if (!result.response.ok || !result.data) {
    const problem: unknown = result.error;
    const code = problem && typeof problem === "object" && "code" in problem && typeof problem.code === "string" ? problem.code : "unavailable";
    throw new ActionDecisionError(result.response.status, code);
  }
  return result.data;
}

// A retry of the same decision, reason and payload reuses one Idempotency-Key, so a lost response cannot record two decisions.
export function createIdempotencyKeys(newKey: () => string = () => crypto.randomUUID()) {
  let last: { fingerprint: string; key: string } | undefined;
  return (input: Pick<DecisionInput, "actionRequestId" | "decision" | "payloadHash" | "reason">): string => {
    const fingerprint = JSON.stringify([input.actionRequestId, input.decision, input.payloadHash, input.reason]);
    if (last?.fingerprint !== fingerprint) last = { fingerprint, key: newKey() };
    return last.key;
  };
}

export function reauthDestination(returnPath: string): string {
  return `/api/auth/reauth?${new URLSearchParams({ return: returnPath })}`;
}

export type FailureKind = "reauthentication_required" | "payload_changed" | "four_eyes_required" | "request_expired" | "not_pending" | "already_decided" | "forbidden" | "unavailable";
const failureKinds: ReadonlySet<string> = new Set<FailureKind>(["reauthentication_required", "payload_changed", "four_eyes_required", "request_expired", "not_pending", "already_decided", "forbidden"]);
export function failureKind(error: unknown): FailureKind {
  return error instanceof ActionDecisionError && failureKinds.has(error.code) ? error.code as FailureKind : "unavailable";
}
