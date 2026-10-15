import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";

export type ActionRequestEventCache = Pick<QueryClient, "invalidateQueries">;

export function actionRequestQueryKey(actionRequestId?: string) {
  return actionRequestId ? ["action-request", actionRequestId] as const : ["action-request"] as const;
}

export async function invalidateActionRequestQueries(client: ActionRequestEventCache, payload?: unknown): Promise<void> {
  const actionRequestId = readActionRequestId(payload);
  await client.invalidateQueries({ queryKey: actionRequestQueryKey(actionRequestId) });
}

export function useActionRequestEvents(): void {
  const client = useQueryClient();
  useEffect(() => {
    const stream = new EventSource("/api/v1/events");
    stream.addEventListener("action_request.updated", (event: MessageEvent<string>) => {
      let payload: unknown;
      try { payload = JSON.parse(event.data); } catch { payload = undefined; }
      void invalidateActionRequestQueries(client, payload);
    });
    return () => stream.close();
  }, [client]);
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
