import { useEffect, useState } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { api, SessionError } from "./api-client";
import { applySimulationEvent, simulationKey, type SimulationRun } from "./simulation-events";

export function useSimulation(): UseQueryResult<SimulationRun | null, SessionError> {
  return useQuery({ queryKey: simulationKey, queryFn: async ({ signal }) => {
    const result = await api.GET("/v1/simulation/runs/current", { signal });
    if (!result.response.ok || result.data === undefined) throw new SessionError(result.response.status);
    return result.data;
  }, retry: false });
}

export function useSimulationEvents() {
  const client = useQueryClient();
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const stream = new EventSource("/api/v1/events");
    stream.onopen = () => setConnected(true);
    stream.onerror = () => { setConnected(false); void client.invalidateQueries({ queryKey: simulationKey }); };
    let queue = Promise.resolve();
    const receive = (event: MessageEvent<string>) => {
      // Serialise cache resets with later ticks; discard older revisions received in flight.
      queue = queue.then(async () => {
        await applySimulationEvent(client, event.type, JSON.parse(event.data));
        setConnected(true);
      }).catch(() => { setConnected(false); void client.invalidateQueries({ queryKey: simulationKey }); });
    };
    stream.addEventListener("simulation.state", receive);
    stream.addEventListener("simulation.reset", receive);
    return () => { stream.close(); };
  }, [client]);
  return connected;
}
