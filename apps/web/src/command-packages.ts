import type { components } from "@fieldloop/contracts";
import { api } from "./api-client";

export type CommandPackage = components["schemas"]["CommandPackage"];
export type CommandPackageStatus = components["schemas"]["CommandPackageExecutionStatus"];
export type CommandPackageOutcome = components["schemas"]["CommandPackageOutcomeCreate"];

export const commandPackageQueryKey = (status: CommandPackageStatus) => ["command-packages", status] as const;

export async function getCommandPackages(signal: AbortSignal, status: CommandPackageStatus): Promise<components["schemas"]["CommandPackagePage"]> {
  const { data, response } = await api.GET("/v1/command-packages", {
    params: { query: { status, limit: 50 } }, signal,
  });
  if (!response.ok || !data) throw new Error("Command Packages are unavailable");
  return data;
}

export async function recordCommandPackageOutcome(
  commandPackageId: string,
  outcome: CommandPackageOutcome,
  csrfToken: string,
): Promise<CommandPackage> {
  const { data, response } = await api.POST("/v1/command-packages/{commandPackageId}/outcome", {
    params: { path: { commandPackageId }, header: { "X-CSRF-Token": csrfToken, "Idempotency-Key": `command-outcome:${crypto.randomUUID()}` } },
    body: outcome,
  });
  if (!response.ok || !data) throw new Error("Command Package outcome could not be recorded");
  return data;
}
