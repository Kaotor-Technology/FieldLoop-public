import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AuditServiceError, type AuditEventFilter, type AuditServicePort } from "./model.js";

const entityTypePattern = /^[a-z][a-z0-9_]{0,63}$/;
const readers = ["fieldloop.operator", "fieldloop.manager"];

export function registerAuditRoutes(app: FastifyInstance, audit?: AuditServicePort): void {
  app.register(async (routes) => {
    routes.setErrorHandler((error: unknown, request, reply) => {
      if (error instanceof AuditServiceError) return sendProblem(request, reply, error.status, error.code);
      const framework = (error as { statusCode?: number } | null)?.statusCode;
      if (framework && framework >= 400 && framework < 500) return sendProblem(request, reply, 400, "validation_failed");
      request.log.error({ errorType: error instanceof Error ? error.name : "unknown" }, "Audit service failed");
      return sendProblem(request, reply, 503, "service_unavailable");
    });

    routes.get("/api/v1/audit", async (request, reply) => {
      const user = request.fieldLoopCurrentUser;
      if (!user) throw new AuditServiceError(401, "unauthenticated");
      if (!user.roles.some((role) => readers.includes(role))) throw new AuditServiceError(403, "forbidden");
      if (!audit) throw new AuditServiceError(503, "service_unavailable");
      const query = request.query as Record<string, unknown>;
      const { entityType, entityId, cursor, limit: rawLimit } = query;
      const limit = rawLimit === undefined ? 50 : typeof rawLimit === "string" && /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : Number.NaN;
      if ((entityType !== undefined && (typeof entityType !== "string" || !entityTypePattern.test(entityType)))
        || (entityId !== undefined && (typeof entityId !== "string" || entityId.length < 1 || entityId.length > 256))
        || (cursor !== undefined && (typeof cursor !== "string" || cursor.length < 1 || cursor.length > 512))
        || !Number.isInteger(limit) || limit < 1 || limit > 200
        || Object.keys(query).some((key) => !["entityType", "entityId", "cursor", "limit"].includes(key))) {
        throw new AuditServiceError(400, "validation_failed");
      }
      const filter: AuditEventFilter = {
        ...(typeof entityType === "string" ? { entityType } : {}),
        ...(typeof entityId === "string" ? { entityId } : {}),
      };
      const page = await audit.listEvents(user, filter, typeof cursor === "string" ? cursor : undefined, limit);
      return reply.header("cache-control", "private, no-store").send(page);
    });
  });
}

function sendProblem(request: FastifyRequest, reply: FastifyReply, status: number, code: string) {
  const titles: Record<string, string> = {
    validation_failed: "Request validation failed", unauthenticated: "Authentication required",
    forbidden: "Access denied", service_unavailable: "Audit service unavailable",
  };
  return reply.code(status).type("application/problem+json").send({
    type: "about:blank", title: titles[code] ?? "Audit request could not be completed", status, code, traceId: request.id,
  });
}
