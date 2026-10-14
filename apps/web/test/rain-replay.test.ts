import { QueryClient } from "@tanstack/react-query";
import { expect, it } from "vitest";
import { applySimulationEvent, simulationKey, type SimulationRun } from "../src/simulation-events";
import { selectSimulatedRainCell } from "../src/map-view";
import type { MapFeature } from "@fieldloop/map";
import { rainSnapshot } from "./fixtures/rain-replay";

const zone: MapFeature = {
  type: "Feature", id: "synthetic-zone-z3",
  geometry: { type: "Polygon", coordinates: [[[100.55, 13.75], [100.6, 13.75], [100.6, 13.8], [100.55, 13.75]]] },
  properties: {
    name: "Demo drainage zone Z3 (SIMULATION)", code: "Z3", featureKind: "area", classification: "CONFIDENTIAL",
    simulated: true, label: "SIMULATION", health: null, riskBand: null, chainageFrom: null, chainageTo: null,
    evidenceObservedAt: null, domainPack: "flood-water",
  },
};

it("FL-40 follows real Scenario B play, pause, one-event steps and reset through the SSE cache", async () => {
  const client = new QueryClient();
  const cell = () => selectSimulatedRainCell(client.getQueryData(simulationKey), [zone]);
  const receive = async (name: string) => {
    const snapshot = rainSnapshot(name);
    await applySimulationEvent(client, name === "reset" ? "simulation.reset" : "simulation.state", snapshot);
    return snapshot;
  };
  await receive("ready");
  expect(cell()).toBeNull();
  const playing = await receive("playing");
  expect(playing?.elapsedSeconds).toBe(0);
  expect(cell()).toEqual({ feature: zone, rateMillimetersPerHour: 72 });
  const paused = await receive("paused");
  const later = await receive("pausedLater");
  expect(later?.elapsedSeconds).toBe(paused?.elapsedSeconds);
  expect(cell()).not.toBeNull();
  for (const name of ["canalRising", "accumulation3600", "accumulation7200"]) {
    await receive(name);
    expect(cell(), name).not.toBeNull();
  }
  expect(client.getQueryData<SimulationRun>(simulationKey)?.elapsedSeconds).toBe(7200);
  await receive("rainLeaves");
  expect(cell()).toBeNull();
  await receive("reset");
  expect(cell()).toBeNull();
  // An old stream tick cannot bring the rain back after reset.
  await applySimulationEvent(client, "simulation.state", playing);
  expect(cell()).toBeNull();
});
