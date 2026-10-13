import type { QueryClient } from "@tanstack/react-query";

export const healthProposalsQueryKey = ["health-proposals"] as const;

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
