import createClient from "openapi-fetch";
import type { components, paths } from "@fieldloop/contracts";
import { createCloudRunFetch, type ServiceFetch } from "@fieldloop/adapters";

export type AgentSessionCreate = components["schemas"]["AgentSessionCreate"];
export type AgentMessageCreate = components["schemas"]["AgentMessageCreate"];
export interface AssistantPort {
  create(body: AgentSessionCreate, token: string, signal: AbortSignal): Promise<components["schemas"]["AgentSession"]>;
  message(id: string, body: AgentMessageCreate, token: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  cancel(id: string, token: string, signal: AbortSignal): Promise<{ cancelling: boolean }>;
}
export class AssistantError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export class RemoteAssistantClient implements AssistantPort {
  private readonly client;
  constructor(baseUrl: string, serviceFetch: ServiceFetch) {
    // Keep the established FL-88 service paths behind the canonical browser contract.
    this.client = createClient<paths>({ baseUrl, fetch: (request) => {
      const url = new URL(request.url);
      url.pathname = url.pathname.replace(/^\/v1\/assistant\//, "/assistant/v1/");
      const serviceHeaders = new Headers(request.headers);
      serviceHeaders.delete("x-csrf-token");
      return serviceFetch(new Request(new Request(url, request), { headers: serviceHeaders }));
    } });
  }
  async create(body: AgentSessionCreate, token: string, signal: AbortSignal) {
    const result = await this.client.POST("/v1/assistant/sessions", {
      body, params: { header: { "X-CSRF-Token": "internal" } }, headers: headers(token), signal,
    });
    checked(result.response);
    const value = result.data;
    if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id) || value.agent !== body.agent ||
        typeof value.status !== "string" || typeof value.simulated !== "boolean" || !["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED"].includes(value.classification)) {
      throw new AssistantError(503, "service_unavailable");
    }
    return { id: value.id, agent: value.agent, simulated: value.simulated, classification: value.classification, status: value.status };
  }
  async message(id: string, body: AgentMessageCreate, token: string, signal: AbortSignal) {
    const result = await this.client.POST("/v1/assistant/sessions/{sessionId}/messages", {
      body, params: { path: { sessionId: id }, header: { "X-CSRF-Token": "internal" } }, headers: headers(token), signal, parseAs: "stream" as const,
    });
    checked(result.response);
    if (!result.data || !result.response.headers.get("content-type")?.startsWith("text/event-stream")) {
      await result.data?.cancel();
      throw new AssistantError(503, "service_unavailable");
    }
    return result.data;
  }
  async cancel(id: string, token: string, signal: AbortSignal) {
    const result = await this.client.POST("/v1/assistant/sessions/{sessionId}:cancel", {
      params: { path: { sessionId: id }, header: { "X-CSRF-Token": "internal" } }, headers: headers(token), signal,
    });
    checked(result.response);
    if (!result.data || typeof result.data.cancelling !== "boolean") throw new AssistantError(503, "service_unavailable");
    return result.data;
  }
}
function headers(token: string) { return { "x-fieldloop-internal-user-token": token }; }
function checked(response: Response) {
  if (response.ok) return;
  const status = [400, 401, 403, 404, 409].includes(response.status) ? response.status : 503;
  throw new AssistantError(status, ({ 400: "validation_failed", 401: "unauthenticated", 403: "forbidden", 404: "not_found", 409: "conflict" } as Record<number, string>)[status] ?? "service_unavailable");
}
export function assistantClientFromEnvironment(): AssistantPort | undefined {
  const baseUrl = process.env["FIELDLOOP_ASSISTANT_URL"];
  if (!baseUrl) return undefined;
  const url = new URL(baseUrl);
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("Assistant URL must be an origin");
  if (process.env["FIELDLOOP_ENV"] === "local") {
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) throw new Error("Local assistant requires loopback HTTP");
    return new RemoteAssistantClient(url.origin, (request) => fetch(request, { redirect: "error" }));
  }
  return new RemoteAssistantClient(url.origin, createCloudRunFetch(url.origin));
}
