import { useEffect, useState } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { api, SessionError } from "./api-client";
import { applySimulationEvent, simulationKey, type SimulationRun } from "./simulation-events";
import { applyRiskRecalculatedEvent } from "./risk-events";
import { invalidateHealthProposalQueries } from "./health-proposals";

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
    stream.onerror = () => {
      setConnected(false);
      void client.invalidateQueries({ queryKey: simulationKey });
      void client.invalidateQueries({ queryKey: ["bowtie"] });
    };
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
    const refreshHealthProposals: EventListener = (event) => {
      let payload: unknown;
      if ("data" in event && typeof event.data === "string") {
        try { payload = JSON.parse(event.data); } catch { payload = undefined; }
      }
      void invalidateHealthProposalQueries(client, event.type, payload);
    };
    stream.addEventListener("risk.recalculated", (event: MessageEvent<string>) => {
      try {
        const payload: unknown = JSON.parse(event.data);
        if (!applyRiskRecalculatedEvent(client, payload)) void client.invalidateQueries({ queryKey: ["bowtie"] });
      } catch {
        void client.invalidateQueries({ queryKey: ["bowtie"] });
      }
      setConnected(true);
    });
    stream.addEventListener("health_proposal.created", refreshHealthProposals);
    stream.addEventListener("barrier.health_changed", refreshHealthProposals);
    return () => { stream.close(); };
  }, [client]);
  return connected;
}
