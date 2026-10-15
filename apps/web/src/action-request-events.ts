import type { QueryClient } from "@tanstack/react-query";
import { actionRequestQueryKey } from "./action-approval";

export type ActionRequestEventCache = Pick<QueryClient, "invalidateQueries">;

export async function invalidateActionRequestQueries(client: ActionRequestEventCache, payload?: unknown): Promise<void> {
  const actionRequestId = readActionRequestId(payload);
  await client.invalidateQueries({ queryKey: actionRequestQueryKey(actionRequestId) });
}

function readActionRequestId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  for (const field of ["actionRequestId", "action_request_id", "entityId"]) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
