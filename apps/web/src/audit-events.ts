import type { components } from "@fieldloop/contracts";
import { api } from "./api-client";

export type AuditEventPage = components["schemas"]["AuditEventPage"];
export type AuditEvent = components["schemas"]["AuditEvent"];
export interface AuditFilter { entityType?: string; entityId?: string }

export const auditQueryKey = (filter: AuditFilter) => ["audit", filter.entityType ?? "", filter.entityId ?? ""] as const;
// Same pattern as the API: the namespace before the first dot of an action.
export const entityTypePattern = /^[a-z][a-z0-9_]{0,63}$/;

export async function getAuditPage(signal: AbortSignal, filter: AuditFilter, cursor?: string): Promise<AuditEventPage> {
  const { data, response } = await api.GET("/v1/audit", {
    params: { query: {
      limit: 50,
      ...(filter.entityType ? { entityType: filter.entityType } : {}),
      ...(filter.entityId ? { entityId: filter.entityId } : {}),
      ...(cursor ? { cursor } : {}),
    } }, signal,
  });
  if (!response.ok || !data) throw new Error("Audit events are unavailable");
  return data;
}

// Audit is readable by operators and managers; the API enforces the same rule.
export function canReadAudit(roles: readonly string[]): boolean {
  return roles.some((role) => role === "fieldloop.operator" || role === "fieldloop.manager");
}

// "2026-10-14T08:39:59.123456Z" -> "2026-10-14 08:39:59.123456 UTC"
export function formatAuditTime(createdAt: string): string {
  return `${createdAt.slice(0, 10)} ${createdAt.slice(11, 26)} UTC`;
}
