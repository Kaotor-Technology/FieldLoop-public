import type { components } from "@fieldloop/contracts";
import { api } from "./api-client";

export type CommandPackage = components["schemas"]["CommandPackage"];
export type CommandPackageStatus = components["schemas"]["CommandPackageExecutionStatus"];
export type CommandPackageOutcome = components["schemas"]["CommandPackageOutcomeCreate"];
export const commandPackageStatuses = ["queued", "executed", "not_executed"] as const satisfies readonly CommandPackageStatus[];

export const commandPackageQueryKey = (status: CommandPackageStatus) => ["command-packages", status] as const;

export async function getCommandPackages(signal: AbortSignal, status: CommandPackageStatus, cursor?: string): Promise<components["schemas"]["CommandPackagePage"]> {
  const { data, response } = await api.GET("/v1/command-packages", {
    params: { query: { status, limit: 50, ...(cursor ? { cursor } : {}) } }, signal,
  });
  if (!response.ok || !data) throw new Error("Command Packages are unavailable");
  return data;
}

export async function recordCommandPackageOutcome(
  commandPackageId: string,
  outcome: CommandPackageOutcome,
  csrfToken: string,
  idempotencyKey: string,
): Promise<CommandPackage> {
  const { data, response } = await api.POST("/v1/command-packages/{commandPackageId}/outcome", {
    params: { path: { commandPackageId }, header: { "X-CSRF-Token": csrfToken, "Idempotency-Key": idempotencyKey } },
    body: outcome,
  });
  if (!response.ok || !data) throw new Error("Command Package outcome could not be recorded");
  return data;
}
