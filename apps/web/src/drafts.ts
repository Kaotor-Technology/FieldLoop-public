import type { components } from "@fieldloop/contracts";
import { api } from "./api-client";

export type Draft = components["schemas"]["Draft"];
export type DraftStatus = Draft["status"];
export const draftListQueryKey = (status: DraftStatus) => ["drafts", status] as const;
export const draftQueryKey = (draftId: string) => ["draft", draftId] as const;

export class DraftApiError extends Error {
  constructor(readonly status: number, readonly code: string | null) {
    super("Draft request failed");
    this.name = "DraftApiError";
  }
}

export async function getDrafts(status: DraftStatus, signal: AbortSignal): Promise<Draft[]> {
  const { data, error, response } = await api.GET("/v1/drafts", {
    params: { query: { status, limit: 50 } }, signal,
  });
  if (!response.ok || !data) throw toError(response.status, error);
  return data;
}

export async function getDraft(draftId: string, signal: AbortSignal): Promise<Draft> {
  const { data, error, response } = await api.GET("/v1/drafts/{draftId}", {
    params: { path: { draftId } }, signal,
  });
  if (!response.ok || !data) throw toError(response.status, error);
  return data;
}

export async function approveDraft(draftId: string, csrfToken: string): Promise<Draft> {
  const { data, error, response } = await api.POST("/v1/drafts/{draftId}:approve", {
    params: { path: { draftId }, header: { "X-CSRF-Token": csrfToken, "Idempotency-Key": crypto.randomUUID() } },
  });
  if (!response.ok || !data) throw toError(response.status, error);
  return data;
}

export async function rejectDraft(draftId: string, csrfToken: string, reason: string): Promise<Draft> {
  const { data, error, response } = await api.POST("/v1/drafts/{draftId}:reject", {
    params: { path: { draftId }, header: { "X-CSRF-Token": csrfToken, "Idempotency-Key": crypto.randomUUID() } },
    body: { reason },
  });
  if (!response.ok || !data) throw toError(response.status, error);
  return data;
}

function toError(status: number, error: unknown): DraftApiError {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code : null;
  return new DraftApiError(status, code);
}
