import { describe, expect, it } from "vitest";
import { actionRequestIdsForTurn, guardrailNoticeDetails, normalizeActionRequestIds } from "./agent-chat-artifacts";
import type { AgentTurn } from "./agent-chat-store";

const actionRequestId = "00000000-0000-4000-8000-000000000097";

describe("Agent Chat artifacts", () => {
  it("keeps unique valid Action Request IDs from the answer and Guardrail trace", () => {
    const turn = {
      id: "turn-1",
      prompt: "prompt",
      message: "message",
      agentId: "integrity-orchestrator",
      simulated: true,
      classification: "INTERNAL",
      answer: {
        answer: "Answer",
        citations: [],
        retrievedCitations: [],
        known: [],
        unknown: [],
        assumptions: [],
        draftIds: [],
        confidence: "medium",
        confidenceReason: "Fixture",
        actionRequestIds: [actionRequestId],
      },
      steps: [{ name: "guardrail.decision", data: { action_request_id: actionRequestId.toUpperCase() }, stepId: "step-1", status: "done" }],
      partialAnswer: "",
      status: "complete",
    } as AgentTurn;

    expect(actionRequestIdsForTurn(turn)).toEqual([actionRequestId]);
    expect(normalizeActionRequestIds(["bad-id", actionRequestId, actionRequestId])).toEqual([actionRequestId]);
  });

  it.each([
    ["convert_l1", "converted"],
    ["hold_l2", "held"],
    ["block", "blocked"],
    ["redact", "redacted"],
    ["reroute", "rerouted"],
  ] as const)("normalizes Guardrail decision %s into a visible notice", (decision, kind) => {
    const notice = guardrailNoticeDetails({
      name: "guardrail.decision",
      data: { decision, policy_id: "SYNTHETIC-POLICY-1", reason: "Synthetic fixture decision." },
      stepId: "step-1",
      status: "done",
    });

    expect(notice).toEqual({ kind, policyId: "SYNTHETIC-POLICY-1", reason: "Synthetic fixture decision." });
  });
});
