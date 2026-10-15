import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AuthError } from "../auth/service.js";
import { AssistantError, type AssistantPort, type AgentSessionCreate, type AgentMessageCreate } from "./client.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function registerAssistantRoutes(app: FastifyInstance, assistant?: AssistantPort): void {
  app.register(async (routes) => {
    routes.setErrorHandler((error: unknown, request, reply) => {
      const status = error instanceof AuthError ? error.statusCode : error instanceof AssistantError ? error.status :
        (error as { statusCode?: number })?.statusCode === 400 ? 400 : 503;
      const code = error instanceof AuthError || error instanceof AssistantError ? error.code : status === 400 ? "validation_failed" : "service_unavailable";
      request.log.error({ errorType: error instanceof Error ? error.name : "unknown" }, "Assistant request failed");
      return reply.header("cache-control", "private, no-store").code(status).type("application/problem+json")
        .send({ type: "about:blank", title: "Agent Chat request could not be completed", status, code });
    });
    routes.addHook("preHandler", async (_request, reply) => {
      reply.header("cache-control", "private, no-store");
      if (!assistant) throw new AssistantError(503, "service_unavailable");
    });
    function port(): AssistantPort {
      if (!assistant) throw new AssistantError(503, "service_unavailable");
      return assistant;
    }
    async function token(request: FastifyRequest): Promise<string> {
      return app.fieldLoopAuth.issueInternalUserToken(request.cookies["fl_session"]);
    }
    function id(request: FastifyRequest): string {
      const value = (request.params as { sessionId: string }).sessionId;
      if (!uuid.test(value)) throw new AssistantError(400, "validation_failed");
      return value;
    }
    routes.post<{ Body: AgentSessionCreate }>("/api/v1/assistant/sessions", {
      preValidation: async (request) => validateBody(request.body, "agent"),
      schema: { body: { type: "object", additionalProperties: false, required: ["agent"], properties: {
        agent: { type: "string", enum: ["integrity-orchestrator", "flood-situation"] },
      } } },
    }, async (request, reply) => reply.code(201).send(await port().create(request.body, await token(request), AbortSignal.timeout(10_000))));
    routes.post<{ Body: AgentMessageCreate }>("/api/v1/assistant/sessions/:sessionId/messages", {
      preValidation: async (request) => validateBody(request.body, "message"),
      schema: { body: { type: "object", additionalProperties: false, required: ["message"], properties: {
        message: { type: "string", minLength: 1, maxLength: 4000 },
      } } },
    }, async (request, reply) => {
      const sessionId = id(request);
      const controller = new AbortController();
      const disconnect = () => controller.abort();
      reply.raw.once("close", disconnect);
      try {
        const stream = await port().message(sessionId, request.body, await token(request),
          AbortSignal.any([controller.signal, AbortSignal.timeout(70_000)]));
        return reply.type("text/event-stream").header("x-accel-buffering", "no")
          .send(Readable.from(chunks(stream)));
      } catch (error) {
        reply.raw.off("close", disconnect);
        controller.abort();
        throw error;
      }
    });
    // Escaped colon is a literal command delimiter in find-my-way.
    routes.post("/api/v1/assistant/sessions/:sessionId([0-9a-fA-F-]{36})::cancel", async (request, reply) =>
      reply.code(202).send(await port().cancel(id(request), await token(request), AbortSignal.timeout(10_000))));
  });
}

function validateBody(body: unknown, allowed: string): void {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some((key) => key !== allowed) ||
      typeof (body as Record<string, unknown>)[allowed] !== "string") {
    throw new AssistantError(400, "validation_failed");
  }
}
async function* chunks(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      yield chunk.value;
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
