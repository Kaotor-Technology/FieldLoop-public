import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { HealthServiceError, type HealthServicePort } from "./model.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idempotencyPattern = /^[A-Za-z0-9._:-]{16,128}$/;

export function registerHealthRoutes(app: FastifyInstance, health?: HealthServicePort): void {
  app.register(async (routes) => {
    routes.setErrorHandler((error: unknown, request, reply) => {
      if (error instanceof HealthServiceError) return sendProblem(request, reply, error.status, error.code);
      const framework = (error as { statusCode?: number } | null)?.statusCode;
      if (framework && framework >= 400 && framework < 500) return sendProblem(request, reply, 400, "validation_failed");
      request.log.error({ errorType: error instanceof Error ? error.name : "unknown" }, "Health service failed");
      return sendProblem(request, reply, 503, "service_unavailable");
    });

    const service = (): HealthServicePort => {
      if (!health) throw new HealthServiceError(503, "service_unavailable");
      return health;
    };
    for (const decision of ["accept", "reject"] as const) {
      routes.post(`/api/v1/health-proposals/:healthProposalId([0-9a-fA-F-]{36})::${decision}`, async (request, reply) => {
        const user = currentUser(request);
        if (!user.roles.some((role) => role === "fieldloop.operator" || role === "fieldloop.manager")) {
          throw new HealthServiceError(403, "forbidden");
        }
        const proposalId = (request.params as { healthProposalId: string }).healthProposalId;
        if (!uuidPattern.test(proposalId)) throw new HealthServiceError(400, "validation_failed");
        const body = request.body;
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new HealthServiceError(400, "validation_failed");
        const reason = Reflect.get(body, "reason");
        if (typeof reason !== "string" || !reason.trim() || reason.trim().length > 2000
          || Object.keys(body).some((key) => key !== "reason")) {
          throw new HealthServiceError(400, "validation_failed");
        }
        const key = request.headers["idempotency-key"];
        if (typeof key !== "string" || !idempotencyPattern.test(key)) throw new HealthServiceError(400, "validation_failed");
        const result = await service().decide({ user, proposalId, decision,
          reason: reason.trim(), idempotencyKey: key });
        return reply.header("cache-control", "private, no-store").send(result);
      });
    }

    routes.get("/api/v1/health-proposals", async (request, reply) => {
      const query = request.query as Record<string, unknown>;
      const status = query["status"];
      const cursor = query["cursor"];
      const rawLimit = query["limit"];
      const limit = rawLimit === undefined ? 50 : typeof rawLimit === "string" && /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : Number.NaN;
      if (status !== "open" || (cursor !== undefined && (typeof cursor !== "string" || cursor.length < 1 || cursor.length > 512))
        || !Number.isInteger(limit) || limit < 1 || limit > 200
        || Object.keys(query).some((key) => !["status", "cursor", "limit"].includes(key))) {
        throw new HealthServiceError(400, "validation_failed");
      }
      const page = await service().listProposals(currentUser(request), typeof cursor === "string" ? cursor : undefined, limit);
      return reply.header("cache-control", "private, no-store").send(page);
    });

    routes.get("/api/v1/notifications", async (request, reply) => {
      const query = request.query as Record<string, unknown>;
      const cursor = query["cursor"];
      const rawLimit = query["limit"];
      const limit = rawLimit === undefined ? 50 : typeof rawLimit === "string" && /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : Number.NaN;
      if ((cursor !== undefined && (typeof cursor !== "string" || cursor.length < 1 || cursor.length > 512))
        || !Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new HealthServiceError(400, "validation_failed");
      }
      const page = await service().listNotifications(currentUser(request), typeof cursor === "string" ? cursor : undefined, limit);
      return reply.header("cache-control", "private, no-store").send(page);
    });
  });
}

function currentUser(request: FastifyRequest) {
  const user = request.fieldLoopCurrentUser;
  if (!user) throw new HealthServiceError(401, "unauthenticated");
  return user;
}
function sendProblem(request: FastifyRequest, reply: FastifyReply, status: number, code: string) {
  const titles: Record<string, string> = {
    validation_failed: "Request validation failed", unauthenticated: "Authentication required",
    forbidden: "Access denied", not_found: "Resource not found", conflict: "Request conflicts with current state",
    idempotency_key_reused: "Idempotency key was already used", service_unavailable: "Health service unavailable",
  };
  return reply.code(status).type("application/problem+json").send({
    type: "about:blank", title: titles[code] ?? "Health request could not be completed", status, code, traceId: request.id,
  });
}
