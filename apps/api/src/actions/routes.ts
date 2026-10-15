import type { FastifyInstance } from "fastify";
import { ActionError, type ActionServicePort } from "@fieldloop/adapters";
import { isActionRequestCreate } from "@fieldloop/contracts";
export function registerActionRoutes(app: FastifyInstance, actions?: ActionServicePort): void {
  app.register(async routes => {
    routes.setErrorHandler((error: unknown, request, reply) => {
      const frameworkStatus = error && typeof error === "object" && "statusCode" in error ? error.statusCode : undefined;
      const status = error instanceof ActionError ? error.status
        : typeof frameworkStatus === "number" && frameworkStatus >= 400 && frameworkStatus < 500 ? frameworkStatus : 503;
      const code = error instanceof ActionError ? error.code : status < 500 ? "validation_failed" : "service_unavailable";
      if (status >= 500) request.log.error({ errorType: error instanceof Error ? error.name : "unknown" }, "Action service failed");
      return reply.code(status).type("application/problem+json").send({ type: "about:blank", title: "Action Request could not be completed", status, code, traceId: request.id });
    });
    routes.get("/api/v1/action-requests", async (request, reply) => {
      const user = request.fieldLoopCurrentUser;
      if (!user) throw new ActionError(401, "unauthenticated");
      const query = request.query as Record<string, unknown>;
      const rawLimit = query["limit"];
      const limit = rawLimit === undefined ? 50 : typeof rawLimit === "string" && /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : Number.NaN;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || Object.keys(query).some(key => key !== "limit")) {
        throw new ActionError(400, "validation_failed");
      }
      if (!actions) throw new ActionError(503, "service_unavailable");
      return reply.header("cache-control", "private, no-store").send(await actions.list(user, limit));
    });
    routes.post("/api/v1/action-requests", async (request, reply) => {
      const user = request.fieldLoopCurrentUser;
      if (!user) throw new ActionError(401, "unauthenticated");
      if (!user.roles.some(x => x === "fieldloop.operator" || x === "fieldloop.manager")) throw new ActionError(403, "forbidden");
      if (!isActionRequestCreate(request.body)) throw new ActionError(400, "validation_failed");
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/.test(key)) throw new ActionError(400, "validation_failed");
      if (!actions) throw new ActionError(503, "service_unavailable");
      const result = await actions.create(user, request.body, key);
      return reply.code(201).header("cache-control", "private, no-store").header("location", `/api/v1/action-requests/${result.id}`).send(result);
    });
    routes.get("/api/v1/action-requests/:actionRequestId", async (request, reply) => {
      const user = request.fieldLoopCurrentUser;
      if (!user) throw new ActionError(401, "unauthenticated");
      const { actionRequestId: id } = request.params as { actionRequestId: string };
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new ActionError(400, "validation_failed");
      if (!actions) throw new ActionError(503, "service_unavailable");
      return reply.header("cache-control", "private, no-store").send(await actions.get(user, id));
    });
  });
}
