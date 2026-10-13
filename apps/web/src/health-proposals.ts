import type { QueryClient } from "@tanstack/react-query";
import type { components } from "@fieldloop/contracts";
import { api } from "./api-client";

export const healthProposalsQueryKey = ["health-proposals"] as const;
export type HealthProposalPage = components["schemas"]["HealthProposalPage"];

export async function getHealthProposalPage(signal: AbortSignal, cursor?: string): Promise<HealthProposalPage> {
  const { data, response } = await api.GET("/v1/health-proposals", {
    params: { query: { status: "open", limit: 200, ...(cursor ? { cursor } : {}) } }, signal,
  });
  if (!response.ok || !data) throw new Error("Health Proposals are unavailable");
  return data;
}

export async function decideHealthProposal(input: {
  proposalId: string;
  decision: "accept" | "reject";
  reason: string;
  idempotencyKey: string;
  csrfToken: string;
}): Promise<components["schemas"]["HealthDecisionResult"]> {
  const params = {
    path: { healthProposalId: input.proposalId },
    header: { "X-CSRF-Token": input.csrfToken, "Idempotency-Key": input.idempotencyKey },
  };
  const result = input.decision === "accept"
    ? await api.POST("/v1/health-proposals/{healthProposalId}:accept", { params, body: { reason: input.reason } })
    : await api.POST("/v1/health-proposals/{healthProposalId}:reject", { params, body: { reason: input.reason } });
  if (!result.response.ok || !result.data) throw new Error("Health Proposal decision could not be saved");
  return result.data;
}

export async function invalidateHealthProposalQueries(
  client: Pick<QueryClient, "invalidateQueries">,
  eventType: string,
): Promise<void> {
  if (eventType === "health_proposal.created") {
    await client.invalidateQueries({ queryKey: healthProposalsQueryKey });
    return;
  }

  if (eventType === "barrier.health_changed") {
    await Promise.all([
      client.invalidateQueries({ queryKey: healthProposalsQueryKey }),
      client.invalidateQueries({ queryKey: ["map-layer", "barriers"] }),
    ]);
  }
}
