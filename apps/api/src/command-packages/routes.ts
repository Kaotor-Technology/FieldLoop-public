import type { FastifyInstance, FastifyRequest } from "fastify";
import { CommandPackageError, type CommandPackageExecutionStatus, type CommandPackageServicePort } from "@fieldloop/adapters";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idempotencyKey = /^[A-Za-z0-9._:-]{16,128}$/;
const executionStatuses: readonly CommandPackageExecutionStatus[] = ["queued", "executed", "not_executed"];

export function registerCommandPackageRoutes(app: FastifyInstance, commandPackages?: CommandPackageServicePort): void {
  app.register(async (routes) => {
    const service = () => {
      if (!commandPackages) throw new CommandPackageError(503, "service_unavailable");
      return commandPackages;
    };
    routes.setErrorHandler((error: unknown, request, reply) => {
      const frameworkStatus = error && typeof error === "object" && "statusCode" in error ? error.statusCode : undefined;
      const status = error instanceof CommandPackageError ? error.status
        : typeof frameworkStatus === "number" && frameworkStatus >= 400 && frameworkStatus < 500 ? frameworkStatus : 503;
      const code = error instanceof CommandPackageError ? error.code : status < 500 ? "validation_failed" : "service_unavailable";
      if (status >= 500) request.log.error({ errorType: error instanceof Error ? error.name : "unknown" }, "Command Package request failed");
      return reply.code(status).type("application/problem+json").send({
        type: "about:blank", title: "Command Package request could not be completed", status, code, traceId: request.id,
      });
    });

    routes.addHook("preHandler", async (request, reply) => {
      reply.header("cache-control", "private, no-store");
      const user = request.fieldLoopCurrentUser;
      if (!user) throw new CommandPackageError(401, "unauthenticated");
      if (user.sub.startsWith("agent:") || !user.roles.includes("fieldloop.operator")) throw new CommandPackageError(403, "forbidden");
      service();
    });

    routes.get("/api/v1/command-packages", async (request, reply) => {
      const query = request.query as Record<string, unknown>;
      if (Object.keys(query).some((key) => !["status", "cursor", "limit"].includes(key))) {
        throw new CommandPackageError(400, "validation_failed");
      }
      const status = query["status"] === undefined ? "queued" : query["status"];
      const cursor = query["cursor"];
      const rawLimit = query["limit"];
      const limit = rawLimit === undefined ? 50
        : typeof rawLimit === "number" && Number.isInteger(rawLimit) ? rawLimit
          : typeof rawLimit === "string" && /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : NaN;
      if (typeof status !== "string" || !executionStatuses.includes(status as CommandPackageExecutionStatus)
        || (cursor !== undefined && (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 512))
        || !Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new CommandPackageError(400, "validation_failed");
      }
      const user = currentUser(request);
      return reply.send(await service().list(user, status as CommandPackageExecutionStatus, cursor as string | undefined, limit));
    });

    routes.post("/api/v1/command-packages/:commandPackageId/outcome", { bodyLimit: 4096 }, async (request, reply) => {
      const params = request.params as { commandPackageId?: unknown };
      if (typeof params.commandPackageId !== "string" || !uuid.test(params.commandPackageId)) {
        throw new CommandPackageError(400, "validation_failed");
      }
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !idempotencyKey.test(key)) throw new CommandPackageError(400, "validation_failed");
      const body = request.body;
      if (!isOutcomeBody(body)) throw new CommandPackageError(400, "validation_failed");
      const result = await service().recordOutcome(currentUser(request), params.commandPackageId, body, key);
      return reply.send(result);
    });
  });
}

function currentUser(request: FastifyRequest) {
  const user = request.fieldLoopCurrentUser;
  if (!user) throw new CommandPackageError(401, "unauthenticated");
  return user;
}

function isOutcomeBody(value: unknown): value is { executionStatus: "executed" | "not_executed"; outcome: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return Object.keys(body).length === 2
    && (body["executionStatus"] === "executed" || body["executionStatus"] === "not_executed")
    && typeof body["outcome"] === "string" && body["outcome"].trim().length > 0 && body["outcome"].trim().length <= 2000;
}
