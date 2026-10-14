import type { QueryClient } from "@tanstack/react-query";
import { isWorkerEvent, type components } from "@fieldloop/contracts";
import type { MapFeatureCollection } from "@fieldloop/map";
import { api } from "./api-client";

export const healthProposalsQueryKey = ["health-proposals"] as const;
const barrierLayerQueryKey = ["map-layer", "barriers"] as const;
export type HealthProposalPage = components["schemas"]["HealthProposalPage"];
type BarrierHealth = components["schemas"]["HealthDecisionResult"]["health"];
type HealthEventCache = Pick<QueryClient, "cancelQueries" | "invalidateQueries" | "setQueriesData">;

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
  client: HealthEventCache,
  eventType: string,
  payload?: unknown,
): Promise<void> {
  if (eventType === "health_proposal.created") {
    await client.invalidateQueries({ queryKey: healthProposalsQueryKey });
    return;
  }

  if (eventType === "barrier.health_changed") {
    const event = isWorkerEvent(payload) && payload.type === "barrier.health_changed" ? payload : undefined;
    if (event?.health) {
      await applyBarrierHealthToMapCache(client, event.barrierId, event.health);
      await client.invalidateQueries({ queryKey: healthProposalsQueryKey });
      return;
    }
    await Promise.all([
      client.invalidateQueries({ queryKey: healthProposalsQueryKey }),
      client.invalidateQueries({ queryKey: barrierLayerQueryKey }),
    ]);
  }
}

export async function applyBarrierHealthToMapCache(
  client: HealthEventCache,
  barrierId: string,
  health: BarrierHealth,
): Promise<void> {
  await client.cancelQueries({ queryKey: barrierLayerQueryKey });
  client.setQueriesData<MapFeatureCollection>({ queryKey: barrierLayerQueryKey }, (collection) => {
    if (!collection) return collection;
    let changed = false;
    const features = collection.features.map((feature) => {
      if (feature.id !== barrierId || feature.properties.featureKind !== "barrier" || feature.properties.health === health) {
        return feature;
      }
      changed = true;
      return { ...feature, properties: { ...feature.properties, health } };
    });
    return changed ? { ...collection, features } : collection;
  });
}
