import type { QueryClient } from "@tanstack/react-query";

export function applyRiskRecalculatedEvent(client: QueryClient, payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || !("bowtieId" in payload) || typeof payload.bowtieId !== "string") return false;
  void client.invalidateQueries({ queryKey: ["bowtie", payload.bowtieId, "risk"] });
  void client.invalidateQueries({ queryKey: ["bowtie", payload.bowtieId, "risk", "explain"] });
  return true;
}
