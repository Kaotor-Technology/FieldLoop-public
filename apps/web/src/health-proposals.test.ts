import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
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

it("refreshes the proposal queue and barrier map layers after Health changes", async () => {
  const { client, invalidateQueries } = createClient();
  await invalidateHealthProposalQueries(client, "barrier.health_changed");
  expect(invalidateQueries).toHaveBeenCalledTimes(2);
  expect(invalidateQueries).toHaveBeenNthCalledWith(1, { queryKey: healthProposalsQueryKey });
  expect(invalidateQueries).toHaveBeenNthCalledWith(2, { queryKey: ["map-layer", "barriers"] });
});

it("ignores events outside the Health Proposal refresh contract", async () => {
  const { client, invalidateQueries } = createClient();
  await invalidateHealthProposalQueries(client, "simulation.state");
  expect(invalidateQueries).not.toHaveBeenCalled();
});
