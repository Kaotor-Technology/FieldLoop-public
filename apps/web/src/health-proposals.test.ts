import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { MapFeatureCollection } from "@fieldloop/map";
import { healthProposalsQueryKey, invalidateHealthProposalQueries } from "./health-proposals";

const clients: QueryClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.clear(); });

function createClient() {
  const client = new QueryClient();
  clients.push(client);
  const invalidateQueries = vi.spyOn(client, "invalidateQueries").mockResolvedValue(undefined);
  return { client, invalidateQueries };
}

it("refreshes the proposal queue when a proposal is created", async () => {
  const { client, invalidateQueries } = createClient();
  await invalidateHealthProposalQueries(client, "health_proposal.created");
  expect(invalidateQueries).toHaveBeenCalledExactlyOnceWith({ queryKey: healthProposalsQueryKey });
});

it("refreshes proposal and map layers for legacy Health events without a Health value", async () => {
  const { client, invalidateQueries } = createClient();
  await invalidateHealthProposalQueries(client, "barrier.health_changed");
  expect(invalidateQueries).toHaveBeenCalledTimes(2);
  expect(invalidateQueries).toHaveBeenNthCalledWith(1, { queryKey: healthProposalsQueryKey });
  expect(invalidateQueries).toHaveBeenNthCalledWith(2, { queryKey: ["map-layer", "barriers"] });
});

it("patches every cached Barrier marker from a Health event without refetching the layer", async () => {
  const client = new QueryClient();
  clients.push(client);
  const barrierId = "00000000-0000-4000-8000-000000000183";
  const otherBarrierId = "00000000-0000-4000-8000-000000000184";
  const collection = (health: "healthy" | "degraded"): MapFeatureCollection => ({
    type: "FeatureCollection",
    features: [
      { type: "Feature", id: barrierId, geometry: { type: "Point", coordinates: [99, 18] },
        properties: { featureKind: "barrier", health, simulated: true } },
      { type: "Feature", id: otherBarrierId, geometry: { type: "Point", coordinates: [99.1, 18] },
        properties: { featureKind: "barrier", health: "healthy", simulated: true } },
    ],
  });
  const firstViewport = ["map-layer", "barriers", [98, 17, 100, 19], 8] as const;
  const secondViewport = ["map-layer", "barriers", [98.5, 17.5, 100, 18.5], 10] as const;
  client.setQueryData(firstViewport, collection("healthy"));
  client.setQueryData(secondViewport, collection("healthy"));
  const cancelQueries = vi.spyOn(client, "cancelQueries");
  const invalidateQueries = vi.spyOn(client, "invalidateQueries").mockResolvedValue(undefined);

  await invalidateHealthProposalQueries(client, "barrier.health_changed", {
    id: "00000000-0000-4000-8000-000000000285", type: "barrier.health_changed", orgId: "synthetic-org",
    entityId: "00000000-0000-4000-8000-000000000385", barrierId, simulated: true,
    classification: "CONFIDENTIAL", health: "degraded",
  });

  for (const key of [firstViewport, secondViewport]) {
    const updated = client.getQueryData<MapFeatureCollection>(key);
    expect(updated?.features[0]?.properties.health).toBe("degraded");
    expect(updated?.features[1]?.properties.health).toBe("healthy");
  }
  expect(cancelQueries).toHaveBeenCalledExactlyOnceWith({ queryKey: ["map-layer", "barriers"] });
  expect(invalidateQueries).toHaveBeenCalledExactlyOnceWith({ queryKey: healthProposalsQueryKey });
});

it("ignores events outside the Health Proposal refresh contract", async () => {
  const { client, invalidateQueries } = createClient();
  await invalidateHealthProposalQueries(client, "simulation.state");
  expect(invalidateQueries).not.toHaveBeenCalled();
});
