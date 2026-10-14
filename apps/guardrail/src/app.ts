import { ActionError } from "@fieldloop/adapters";
import { isToolCallCheck } from "@fieldloop/contracts";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { isClassification, type ChatCompletionRequest, type ChatMessage, type GuardrailClassification, type GuardrailDependencies } from "./model.js";
import { GuardrailEngine, type GuardrailHttpResult } from "./guardrail-engine.js";
import { InternalUserTokenVerifierUnavailableError, InvalidInternalUserTokenError, type InternalUserIdentity } from "./internal-user-token.js";

const OPENAI_CHAT_COMPLETIONS_PATH = "/guardrail/v1/chat/completions";
const CONTENT_SCAN_PATH = "/guardrail/v1/content:scan";
const INTERNAL_USER_TOKEN_HEADER = "x-fieldloop-internal-user-token";

declare module "fastify" {
  interface FastifyRequest {
    fieldLoopInternalUser?: InternalUserIdentity;
  }
}

export function buildApp(dependencies: GuardrailDependencies) {
  const app = Fastify({ logger: true, bodyLimit: 1_048_576 });
  const engine = new GuardrailEngine({
    ...dependencies,
    logError: dependencies.logError ?? ((error, message) => app.log.error({ err: error }, message)),
  });

  app.setErrorHandler((error, _request, reply) => {
    const errorRecord = error !== null && typeof error === "object" ? error as Record<string, unknown> : null;
    const reportedStatus = errorRecord?.["statusCode"];
    const statusCode = typeof reportedStatus === "number" && reportedStatus >= 400 && reportedStatus <= 599
      ? reportedStatus
      : 500;
    const code = statusCode === 413 ? "payload_too_large"
      : statusCode === 415 ? "unsupported_media_type"
        : statusCode < 500 ? "validation_failed"
          : "internal_error";
    const reportedMessage = errorRecord?.["message"];
    const message = statusCode >= 500 ? "Guardrail request could not be processed"
      : typeof reportedMessage === "string" ? reportedMessage : "Request could not be parsed";
    if (statusCode >= 500) reply.log.error({ err: error }, "Guardrail request failed");
    return reply.code(statusCode).type("application/problem+json")
      .send(errorBody(code, message, statusCode, code));
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).type("application/problem+json")
    .send(errorBody("not_found", "Guardrail route not found", 404, "not_found")));

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/guardrail/v1/tool-calls:check", { onRequest: (request, reply) => authenticateUser(request, reply, dependencies) }, async (request, reply) => {
    if (!isToolCallCheck(request.body) || request.body.simulated !== dependencies.simulated) return sendAuthProblem(reply, 400, "validation_failed", "Invalid tool call or simulation scope");
    const identity = request.fieldLoopInternalUser;
    if (!identity) return sendAuthProblem(reply, 401, "unauthenticated", "A valid internal user token is required");
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/.test(key)) return sendAuthProblem(reply, 400, "validation_failed", "Idempotency-Key is required");
    if (!dependencies.actions) return sendAuthProblem(reply, 503, "service_unavailable", "Tool-call service is unavailable");
    try {
      const result = await dependencies.actions.check(identity, request.body, key);
      return reply.header("cache-control", "private, no-store").send(result);
    } catch (error) {
      if (error instanceof ActionError) return sendAuthProblem(reply, error.status, error.code, "Tool call could not be checked");
      request.log.error({ errorType: error instanceof Error ? error.name : "unknown" }, "Tool-call check failed closed");
      return sendAuthProblem(reply, 503, "service_unavailable", "Tool call could not be checked");
    }
  });

  app.post(CONTENT_SCAN_PATH, { onRequest: (request, reply) => authenticateUser(request, reply, dependencies) }, async (request, reply) => {
    if (!isJsonMediaType(request.headers["content-type"])) {
      return reply.code(415).type("application/problem+json").send(errorBody("unsupported_media_type", "Content-Type must be application/json", 415, "unsupported_media_type"));
    }
    const body = parseContentScan(request.body);
    if (!body) return reply.code(400).type("application/problem+json").send(errorBody("validation_failed", "Expected aiSystem and text content", 400, "invalid_request"));
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 16 || idempotencyKey.length > 128) {
      return reply.code(400).type("application/problem+json").send(errorBody("validation_failed", "Idempotency-Key must contain between 16 and 128 characters", 400, "invalid_idempotency_key"));
    }
    const classification = requestClassification(request.headers["x-fieldloop-classification"]);
    if (!classification) return reply.code(400).type("application/problem+json").send(errorBody("validation_failed", "Classification header is invalid", 400, "invalid_classification"));
    const identity = request.fieldLoopInternalUser;
    if (!identity) return sendAuthProblem(reply, 401, "unauthenticated", "A valid internal user token is required");
    const result = await engine.scanContent({ ...body, classification, idempotencyKey, clearance: identity.clearance });
    return sendResult(reply, result, classification);
  });

  app.post(OPENAI_CHAT_COMPLETIONS_PATH, { onRequest: (request, reply) => authenticateUser(request, reply, dependencies) }, async (request, reply) => {
    if (!isJsonMediaType(request.headers["content-type"])) {
      return reply.code(415).type("application/problem+json").send(errorBody("unsupported_media_type", "Content-Type must be application/json", 415, "unsupported_media_type"));
    }
    const body = parseChatCompletion(request.body);
    if (!body) return reply.code(400).type("application/problem+json").send(errorBody("validation_failed", "Expected aiSystem and text chat messages", 400, "invalid_request"));
    const classification = requestClassification(request.headers["x-fieldloop-classification"]);
    if (!classification) return reply.code(400).type("application/problem+json").send(errorBody("validation_failed", "Classification header is invalid", 400, "invalid_classification"));
    const identity = request.fieldLoopInternalUser;
    if (!identity) return sendAuthProblem(reply, 401, "unauthenticated", "A valid internal user token is required");
    const result = await engine.chatCompletion(body, classification, identity.clearance);
    return sendResult(reply, result, classification, body.stream === true);
  });

  return app;
}

async function authenticateUser(request: FastifyRequest, reply: FastifyReply, dependencies: GuardrailDependencies) {
  const token = request.headers[INTERNAL_USER_TOKEN_HEADER];
  if (typeof token !== "string" || token.length < 16 || token.length > 8_192 || token.trim() !== token) {
    return sendAuthProblem(reply, 401, "unauthenticated", "A valid internal user token is required");
  }
  try {
    const identity = await dependencies.userTokenVerifier.verify(token);
    if (identity.orgId !== dependencies.orgId) {
      return sendAuthProblem(reply, 403, "forbidden", "Internal user token Organisation is not available to this service");
    }
    request.fieldLoopInternalUser = identity;
  } catch (error) {
    if (error instanceof InvalidInternalUserTokenError) {
      return sendAuthProblem(reply, 401, "unauthenticated", "Internal user token failed verification");
    }
    if (error instanceof InternalUserTokenVerifierUnavailableError) {
      return sendAuthProblem(reply, 503, "service_unavailable", "Internal user token verification is unavailable");
    }
    request.log.error({ err: error }, "Guardrail internal identity verification failed");
    return sendAuthProblem(reply, 503, "service_unavailable", "Internal user token verification is unavailable");
  }
}

function sendAuthProblem(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).type("application/problem+json").send(errorBody(code, message, status, code));
}

function parseContentScan(value: unknown): { aiSystem: string; content: string } | null {
  const body = asRecord(value);
  if (!body) return null;
  const aiSystem = body["aiSystem"] ?? body["ai_system"];
  if (typeof aiSystem !== "string" || aiSystem.length < 1 || aiSystem.length > 128
    || typeof body["content"] !== "string" || body["content"].length > 250_000) return null;
  return { aiSystem, content: body["content"] };
}

function parseChatCompletion(value: unknown): ChatCompletionRequest | null {
  const body = asRecord(value);
  if (!body) return null;
  const aiSystem = body["aiSystem"] ?? body["ai_system"];
  if (typeof aiSystem !== "string" || aiSystem.length < 1 || aiSystem.length > 128
    || !Array.isArray(body["messages"]) || body["messages"].length < 1 || body["messages"].length > 128) return null;
  if (body["model"] !== undefined && body["model"] !== "flash" && body["model"] !== "pro") return null;
  if (body["stream"] !== undefined && typeof body["stream"] !== "boolean") return null;
  const messages = body["messages"].map(parseMessage);
  if (messages.some((message) => message === null)) return null;
  const request: Record<string, unknown> = { ...body, ai_system: aiSystem, messages: messages as ChatMessage[] };
  delete request["aiSystem"];
  return request as ChatCompletionRequest;
}

function parseMessage(value: unknown): ChatMessage | null {
  const message = asRecord(value);
  if (!message) return null;
  const role = message["role"];
  if (role !== "system" && role !== "developer" && role !== "user" && role !== "assistant" && role !== "tool") return null;
  if (message["content"] !== undefined && message["content"] !== null && typeof message["content"] !== "string") return null;
  return { ...message, role } as ChatMessage;
}

function requestClassification(value: string | string[] | undefined): GuardrailClassification | null {
  if (value === undefined) return "INTERNAL";
  if (typeof value !== "string" || !isClassification(value)) return null;
  return value;
}

function isJsonMediaType(value: string | string[] | undefined): boolean {
  return typeof value === "string" && /^application\/json(?:\s*;|$)/i.test(value);
}

function sendResult(reply: FastifyReply, result: GuardrailHttpResult, requestedClassification: GuardrailClassification, stream = false) {
  if (result.policyId) reply.header("x-fieldloop-policy-id", result.policyId);
  if (result.interceptId) reply.header("x-fieldloop-intercept-id", result.interceptId);
  reply.header("x-fieldloop-classification", result.classification ?? requestedClassification);
  reply.code(result.statusCode);
  if (result.statusCode >= 400) reply.type("application/problem+json");
  if (stream && result.statusCode === 200) {
    reply.header("content-type", "text/event-stream; charset=utf-8");
    reply.header("cache-control", "no-cache");
    reply.header("connection", "keep-alive");
    return reply.send(toServerSentEvents(result.body));
  }
  return reply.send(result.body);
}

function toServerSentEvents(value: unknown): string {
  const completion = asRecord(value);
  const choices = completion?.["choices"];
  if (!completion || !Array.isArray(choices)) return "data: [DONE]\n\n";
  const id = typeof completion["id"] === "string" ? completion["id"] : "guardrail-completion";
  const model = typeof completion["model"] === "string" ? completion["model"] : "guardrail";
  const chunks = choices.map((entry, index) => {
    const choice = asRecord(entry);
    const message = asRecord(choice?.["message"]);
    const chunk = {
      id,
      object: "chat.completion.chunk",
      created: typeof completion["created"] === "number" ? completion["created"] : Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: typeof choice?.["index"] === "number" ? choice["index"] : index,
        delta: message ? { role: "assistant", ...message } : { role: "assistant" },
        finish_reason: typeof choice?.["finish_reason"] === "string" ? choice["finish_reason"] : "stop",
      }],
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
  });
  return `${chunks.join("")}data: [DONE]\n\n`;
}

function errorBody(code: string, message: string, status: number, errorCode: string): Record<string, unknown> {
  const title = status === 400 ? "Invalid Guardrail request" : status === 409 ? "Idempotency key conflict"
    : status === 413 ? "Guardrail request is too large" : status === 415 ? "Unsupported request media type"
      : status >= 500 ? "Guardrail unavailable" : "Guardrail request failed";
  return {
    type: `urn:fieldloop:problem:${code}`,
    title,
    status,
    detail: message,
    code,
    error: { type: "guardrail_error", code: errorCode, message },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
