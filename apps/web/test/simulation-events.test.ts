import { QueryClient } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { applySimulationEvent, simulationKey, type SimulationRun } from "../src/simulation-events";
import { useSimulationDraft } from "../src/simulation-draft";

const run: SimulationRun = { id: "11111111-1111-4111-8111-111111111111", revision: 2, orgId: "test-org", scenarioId: "player-test", scenarioName: "Player verification fixture", seed: 42, speed: 1, clock: "2026-10-13T00:00:00Z", elapsedSeconds: 0, durationSeconds: 120, state: "ready", nextEventIndex: 0, eventCount: 3, simulated: true, classification: "INTERNAL", bookmarks: [] };
it("a reset invalidates every server cache and clears transient bookmark selection", async () => {
  const client = new QueryClient();
  client.setQueryData(simulationKey, run); client.setQueryData(["barriers"], ["synthetic"]);
  useSimulationDraft.getState().selectBookmark("failure");
  const reset = { ...run, id: "11111111-1111-4111-8111-111111111112", revision: 3 };
  await applySimulationEvent(client, "simulation.reset", reset);
  expect(client.getQueryData(simulationKey)).toEqual(reset);
  expect(client.getQueryState(["barriers"])?.isInvalidated).toBe(true);
  expect(useSimulationDraft.getState().bookmarkId).toBe("");
});
it("ignores an old stream tick delivered after a confirmed reset", async () => {
  const client = new QueryClient();
  const reset = { ...run, id: "11111111-1111-4111-8111-111111111112", revision: 3 };
  client.setQueryData(simulationKey, reset);
  await applySimulationEvent(client, "simulation.state", run);
  expect(client.getQueryData(simulationKey)).toEqual(reset);
  await expect(applySimulationEvent(client, "simulation.state", { ...run, simulated: false })).rejects.toThrow("Invalid simulation event");
});
