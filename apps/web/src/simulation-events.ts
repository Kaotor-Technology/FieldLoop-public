import type { QueryClient } from "@tanstack/react-query";
import type { components } from "@fieldloop/contracts";
import { useSimulationDraft } from "./simulation-draft";

export type SimulationRun = components["schemas"]["SimulationRun"];
export const simulationKey = ["simulation", "current"] as const;

export async function applySimulationEvent(client: QueryClient, name: string, payload: unknown): Promise<void> {
  const { isSimulationRun } = await import("@fieldloop/contracts/simulation");
  if (!isSimulationRun(payload)) throw new Error("Invalid simulation event");
  const previous = client.getQueryData<SimulationRun | null>(simulationKey);
  if (previous && payload.revision < previous.revision) return;
  const reset = name === "simulation.reset" || (previous && previous.id !== payload.id);
  if (reset) {
    await client.cancelQueries();
    useSimulationDraft.getState().resetTransient();
  }
  client.setQueryData(simulationKey, payload);
  if (reset) await client.invalidateQueries();
}
