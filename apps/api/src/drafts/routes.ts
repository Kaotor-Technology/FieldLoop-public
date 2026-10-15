import type { FastifyInstance, FastifyRequest } from "fastify";
import { DraftServiceError, type DraftServicePort, type DraftStatus } from "./model.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
const STATUSES = new Set<DraftStatus>(["needs_approval", "approved", "rejected"]);

export function registerDraftRoutes(app: FastifyInstance, drafts?: DraftServicePort): void {
  app.register(async (routes) => {
    routes.setErrorHandler((error: unknown, request, reply) => {
      if (error instanceof DraftServiceError) return sendProblem(request, reply, error.status, error.code);
      const frameworkStatus = (error as { statusCode?: number } | null)?.statusCode;
      if (frameworkStatus && frameworkStatus >= 400 && frameworkStatus < 500) {
        return sendProblem(request, reply, frameworkStatus === 413 ? 413 : 400,
          frameworkStatus === 413 ? "payload_too_large" : "validation_failed");
      }
      request.log.error({ errorType: error instanceof Error ? error.name : "unknown" }, "Draft request failed");
      return sendProblem(request, reply, 503, "service_unavailable");
    });

    const service = (): DraftServicePort => {
      if (!drafts) throw new DraftServiceError(503, "service_unavailable");
      return drafts;
    };

    routes.get("/api/v1/drafts", async (request, reply) => {
      const user = currentUser(request);
      const query = request.query as Record<string, unknown>;
      const status = query["status"] ?? "needs_approval";
      const rawLimit = query["limit"];
      const limit = rawLimit === undefined ? 50 : typeof rawLimit === "string" && /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : Number.NaN;
      if (typeof status !== "string" || !STATUSES.has(status as DraftStatus)
        || !Number.isInteger(limit) || limit < 1 || limit > 100
        || Object.keys(query).some((key) => !["status", "limit"].includes(key))) {
        throw new DraftServiceError(400, "validation_failed");
      }
      const items = await service().list(user, status as DraftStatus, limit);
      return reply.header("cache-control", "private, no-store").send(items);
    });

    routes.get("/api/v1/drafts/:draftId", async (request, reply) => {
      const user = currentUser(request);
      const draftId = (request.params as { draftId: string }).draftId;
      if (!UUID_PATTERN.test(draftId)) throw new DraftServiceError(400, "validation_failed");
      return reply.header("cache-control", "private, no-store").send(await service().get(user, draftId));
    });

    routes.post("/api/v1/drafts/:draftId([0-9a-fA-F-]{36})::approve", async (request, reply) => {
      const user = decisionUser(request);
      const draftId = (request.params as { draftId: string }).draftId;
      if (!UUID_PATTERN.test(draftId) || !emptyObject(request.body)) throw new DraftServiceError(400, "validation_failed");
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
        throw new DraftServiceError(400, "validation_failed");
      }
      const draft = await service().decide({ user, draftId, decision: "approve", idempotencyKey });
      return reply.header("cache-control", "private, no-store").send(draft);
    });

    routes.post("/api/v1/drafts/:draftId([0-9a-fA-F-]{36})::reject", async (request, reply) => {
      const user = decisionUser(request);
      const draftId = (request.params as { draftId: string }).draftId;
      if (!UUID_PATTERN.test(draftId)) throw new DraftServiceError(400, "validation_failed");
      const reason = rejectionReason(request.body);
      const idempotencyKey = request.headers["idempotency-key"];
      if (!reason || typeof idempotencyKey !== "string" || !IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
        throw new DraftServiceError(400, "validation_failed");
      }
      const draft = await service().decide({ user, draftId, decision: "reject", reason, idempotencyKey });
      return reply.header("cache-control", "private, no-store").send(draft);
    });
  });
}

function currentUser(request: FastifyRequest) {
  const user = request.fieldLoopCurrentUser;
  if (!user) throw new DraftServiceError(401, "unauthenticated");
  return user;
}

function decisionUser(request: FastifyRequest) {
  const user = currentUser(request);
  if (!user.roles.some((role) => role === "fieldloop.operator" || role === "fieldloop.manager")) {
    throw new DraftServiceError(403, "forbidden");
  }
  return user;
}

function emptyObject(value: unknown): boolean {
  return value === undefined || value === null || (isRecord(value) && Object.keys(value).length === 0);
}

function rejectionReason(value: unknown): string | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value["reason"] !== "string") return undefined;
  const reason = value["reason"].trim();
  return reason.length >= 1 && reason.length <= 2000 ? reason : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendProblem(request: FastifyRequest, reply: import("fastify").FastifyReply, status: number, code: string) {
  const titles: Record<string, string> = {
    validation_failed: "Request validation failed", unauthenticated: "Authentication required",
    forbidden: "Access denied", author_cannot_approve: "The Draft author cannot approve this Draft",
    approver_name_unavailable: "Approver name is unavailable", not_found: "Draft not found",
    conflict: "Draft is no longer awaiting a decision", idempotency_key_reused: "Idempotency key was already used",
    service_unavailable: "Draft service unavailable", payload_too_large: "Request payload is too large",
  };
  return reply.code(status).type("application/problem+json").send({
    type: "about:blank", title: titles[code] ?? "Draft request could not be completed", status, code, traceId: request.id,
  });
}
