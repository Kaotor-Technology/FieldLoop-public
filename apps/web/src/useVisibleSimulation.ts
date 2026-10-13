import { useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { hasVisibleSimulatedData } from "./visible-simulation";

export function useHasVisibleSimulatedData(): boolean {
  const cache = useQueryClient().getQueryCache();
  return useSyncExternalStore(
    (notify) => cache.subscribe(() => notify()),
    () => hasVisibleSimulatedData(cache.getAll().map((query) => ({
      active: query.isActive(),
      data: query.state.data,
      includeInBanner: query.meta?.["includeInSimulationBanner"] !== false,
    }))),
    () => false,
  );
}
