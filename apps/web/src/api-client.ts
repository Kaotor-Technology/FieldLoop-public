import createClient from "openapi-fetch";
import type { paths, components } from "@fieldloop/contracts";

export const api = createClient<paths>({ baseUrl: "/api", credentials: "same-origin", cache: "no-store" });
export type CurrentUser = components["schemas"]["CurrentUser"];

export class SessionError extends Error {
  constructor(readonly status: number) { super("Session request failed"); }
}

export async function getCurrentUser(signal: AbortSignal): Promise<CurrentUser> {
  const { data, response } = await api.GET("/v1/me", { signal });
  if (!response.ok || !data) throw new SessionError(response.status);
  return data;
}

export async function endSession(csrfToken: string): Promise<string> {
  const { data, response } = await api.POST("/auth/logout", {
    params: { header: { "X-CSRF-Token": csrfToken } },
    headers: { Accept: "application/json" },
    redirect: "error",
  });
  if (!response.ok || !data) throw new SessionError(response.status);
  return data.redirectUrl;
}

export function loginDestination(): string {
  const returnPath = location.pathname === "/" ? `/map${location.search}${location.hash}` : `${location.pathname}${location.search}${location.hash}`;
  return `/api/auth/login?${new URLSearchParams({ return: returnPath })}`;
}
