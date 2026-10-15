import { afterEach, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { AuthError, type AuthServicePort } from "../src/auth/service.js";
import { RemoteAssistantClient } from "../src/assistant/client.js";

const sessionId = "00000000-0000-4000-8000-000000000039";
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
function fixture(transport?: (request: Request) => Promise<Response>) {
  const requests: Request[] = [];
  const issue = vi.fn(async () => "server-only-token");
  const auth: AuthServicePort = {
    getCurrentUser: async (cookie) => {
      if (cookie !== "valid") throw new AuthError("Session required", 401);
      return { sub: "synthetic-user", orgId: "synthetic-org", clearance: "INTERNAL", roles: ["fieldloop.viewer"], persona: "Engineer", csrfToken: "fixture-csrf", authTime: new Date() };
    },
    issueInternalUserToken: issue,
    startLogin: async () => new URL("https://example.test"), startReauthentication: async () => new URL("https://example.test"),
    completeLogin: async () => { throw new Error("unused"); }, logout: async () => new URL("https://example.test"),
    backchannelLogout: async () => {}, jwks: async () => ({ keys: [] }),
  };
  const assistant = new RemoteAssistantClient("http://assistant.test", async (request) => {
    requests.push(request);
    if (transport) return transport(request);
    const path = new URL(request.url).pathname;
    if (path.endsWith(":cancel")) return Response.json({ cancelling: true }, { status: 202 });
    if (path.endsWith("/messages")) return new Response('event: agent.step\ndata: {"phase":"start"}\n\nevent: answer.final\ndata: {"answer":"cited answer"}\n\n', { headers: { "content-type": "text/event-stream" } });
    return Response.json({ id: sessionId, agent: "integrity-orchestrator", simulated: true, classification: "INTERNAL", status: "active" }, { status: 201 });
  });
  const app = buildApp({ auth, assistant }); apps.push(app);
  const headers = { cookie: "fl_session=valid", "x-csrf-token": "fixture-csrf", authorization: "Bearer browser-spoof", "x-fieldloop-internal-user-token": "spoof" };
  return { app, headers, requests, issue };
}
it("requires a cookie session and CSRF for every assistant operation before minting a token", async () => {
  const { app, headers, requests, issue } = fixture();
  for (const [url, payload] of [
    ["/api/v1/assistant/sessions", { agent: "integrity-orchestrator" }],
    [`/api/v1/assistant/sessions/${sessionId}/messages`, { message: "CP survey interval?" }],
    [`/api/v1/assistant/sessions/${sessionId}:cancel`, undefined],
  ] as const) {
    expect((await app.inject({ method: "POST", url, ...(payload ? { payload } : {}), headers: { authorization: headers.authorization } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url, ...(payload ? { payload } : {}), headers: { cookie: headers.cookie } })).statusCode).toBe(403);
  }
  expect(requests).toHaveLength(0); expect(issue).not.toHaveBeenCalled();
});
it("forwards create, live SSE and cancel with only server-minted identity", async () => {
  const { app, headers, requests } = fixture();
  const created = await app.inject({ method: "POST", url: "/api/v1/assistant/sessions", headers, payload: { agent: "integrity-orchestrator" } });
  expect(created.statusCode).toBe(201); expect(created.json().id).toBe(sessionId);
  const streamed = await app.inject({ method: "POST", url: `/api/v1/assistant/sessions/${sessionId}/messages`, headers, payload: { message: "CP survey interval?" } });
  expect(streamed.headers["content-type"]).toContain("text/event-stream");
  expect(streamed.body).toContain("event: agent.step"); expect(streamed.body).toContain("event: answer.final");
  expect(streamed.headers["cache-control"]).toContain("no-store");
  expect((await app.inject({ method: "POST", url: `/api/v1/assistant/sessions/${sessionId}:cancel`, headers })).statusCode).toBe(202);
  expect(requests.map((r) => new URL(r.url).pathname)).toEqual(["/assistant/v1/sessions", `/assistant/v1/sessions/${sessionId}/messages`, `/assistant/v1/sessions/${sessionId}:cancel`]);
  for (const request of requests) {
    expect(request.headers.get("x-fieldloop-internal-user-token")).toBe("server-only-token");
    expect(request.headers.get("authorization")).toBeNull(); expect(request.headers.get("cookie")).toBeNull();
    expect(request.headers.get("x-csrf-token")).toBeNull();
  }
  expect(created.body + streamed.body).not.toContain("server-only-token");
});
it("rejects malformed input without invoking the assistant", async () => {
  const { app, headers, requests } = fixture();
  for (const [url, payload] of [
    ["/api/v1/assistant/sessions", { agent: "code-standard" }],
    ["/api/v1/assistant/sessions", { agent: "integrity-orchestrator", simulated: false }],
    [`/api/v1/assistant/sessions/${sessionId}/messages`, { message: "x".repeat(4001) }],
    ["/api/v1/assistant/sessions/invalid/messages", { message: "CP?" }],
  ] as const) {
    expect((await app.inject({ method: "POST", url: url as string, headers, payload })).statusCode).toBe(400);
  }
  expect(requests).toHaveLength(0);
});
it.each([401, 403, 404, 409, 500])("sanitizes upstream %s without leaking error details", async (status) => {
  const { app, headers } = fixture(async () => Response.json({ secret: "private upstream" }, { status }));
  const response = await app.inject({ method: "POST", url: `/api/v1/assistant/sessions/${sessionId}/messages`, headers, payload: { message: "CP?" } });
  expect(response.statusCode).toBe(status === 500 ? 503 : status);
  expect(response.headers["content-type"]).toContain("application/problem+json");
  expect(response.body).not.toContain("private upstream");
});
it("fails closed for malformed successful upstream responses", async () => {
  const { app, headers } = fixture(async () => Response.json({ id: "bad" }));
  expect((await app.inject({ method: "POST", url: "/api/v1/assistant/sessions", headers, payload: { agent: "integrity-orchestrator" } })).statusCode).toBe(503);
  expect((await app.inject({ method: "POST", url: `/api/v1/assistant/sessions/${sessionId}/messages`, headers, payload: { message: "CP?" } })).statusCode).toBe(503);
});

it("delivers steps before completion and cancels through a concurrent BFF request", async () => {
  let pending: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encode = (name: string, data: object) => new TextEncoder().encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  const { app, headers } = fixture(async (request) => {
    if (new URL(request.url).pathname.endsWith(":cancel")) {
      pending?.enqueue(encode("answer.incomplete", { answer: "Stopped", incomplete: "cancelled" }));
      pending?.close();
      return Response.json({ cancelling: true }, { status: 202 });
    }
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      pending = controller;
      controller.enqueue(encode("agent.step", { phase: "start" }));
    } }), { headers: { "content-type": "text/event-stream" } });
  });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const abort = new AbortController();
  try {
    const response = await fetch(`${origin}/api/v1/assistant/sessions/${sessionId}/messages`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ message: "CP interval?" }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No stream");
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toContain("event: agent.step");
    const cancelled = await fetch(`${origin}/api/v1/assistant/sessions/${sessionId}:cancel`, { method: "POST", headers });
    expect(cancelled.status).toBe(202);
    expect(decoder.decode((await reader.read()).value)).toContain("answer.incomplete");
    await reader.cancel();
  } finally { abort.abort(); }
});
