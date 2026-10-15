import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ActionError, type ActionDecision, type ActionDecisionPort, type ActionServicePort } from "@fieldloop/adapters";
import { isActionDecisionCreate, isActionRequestCreate } from "@fieldloop/contracts";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idempotencyKeyPattern = /^[A-Za-z0-9._:-]{16,128}$/;
export function registerActionRoutes(app: FastifyInstance, actions?: ActionServicePort & ActionDecisionPort): void {
  app.register(async routes => {
    routes.setErrorHandler((error: unknown, request, reply) => {
      const frameworkStatus = error && typeof error === "object" && "statusCode" in error ? error.statusCode : undefined;
      const status = error instanceof ActionError ? error.status
        : typeof frameworkStatus === "number" && frameworkStatus >= 400 && frameworkStatus < 500 ? frameworkStatus : 503;
      const code = error instanceof ActionError ? error.code : status < 500 ? "validation_failed" : "service_unavailable";
      if (status >= 500) request.log.error({ errorType: error instanceof Error ? error.name : "unknown" }, "Action service failed");
      return reply.code(status).type("application/problem+json").send({ type: "about:blank", title: "Action Request could not be completed", status, code, traceId: request.id });
    });
    routes.post("/api/v1/action-requests", async (request, reply) => {
      const user = request.fieldLoopCurrentUser;
      if (!user) throw new ActionError(401, "unauthenticated");
      if (!user.roles.some(x => x === "fieldloop.operator" || x === "fieldloop.manager")) throw new ActionError(403, "forbidden");
      if (!isActionRequestCreate(request.body)) throw new ActionError(400, "validation_failed");
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !idempotencyKeyPattern.test(key)) throw new ActionError(400, "validation_failed");
      if (!actions) throw new ActionError(503, "service_unavailable");
      const result = await actions.create(user, request.body, key);
      return reply.code(201).header("cache-control", "private, no-store").header("location", `/api/v1/action-requests/${result.id}`).send(result);
    });
    routes.get("/api/v1/action-requests/:actionRequestId", async (request, reply) => {
      const user = request.fieldLoopCurrentUser;
      if (!user) throw new ActionError(401, "unauthenticated");
      const { actionRequestId: id } = request.params as { actionRequestId: string };
      if (!uuid.test(id)) throw new ActionError(400, "validation_failed");
      if (!actions) throw new ActionError(503, "service_unavailable");
      return reply.header("cache-control", "private, no-store").send(await actions.get(user, id));
    });
    // An Approver decision. The BFF pre-handler has already required a cookie session, CSRF, a fresh introspection
    // and an `auth_time` under 5 minutes old; the internal Bearer token is never accepted here, so an AI subject cannot decide (AX-9).
    const decide = (decision: ActionDecision, status: 200 | 201) => async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.fieldLoopCurrentUser;
      if (!user) throw new ActionError(401, "unauthenticated");
      if (!user.roles.includes("fieldloop.manager")) throw new ActionError(403, "forbidden");
      const { actionRequestId: id } = request.params as { actionRequestId: string };
      if (!uuid.test(id) || !isActionDecisionCreate(request.body)) throw new ActionError(400, "validation_failed");
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !idempotencyKeyPattern.test(key)) throw new ActionError(400, "validation_failed");
      if (!actions) throw new ActionError(503, "service_unavailable");
      return reply.code(status).header("cache-control", "private, no-store").send(await actions.decide(user, id, decision, request.body, key));
    };
    routes.post("/api/v1/action-requests/:actionRequestId/approvals", decide("approved", 201));
    routes.post("/api/v1/action-requests/:actionRequestId([0-9a-fA-F-]{36})::reject", decide("rejected", 200));
  });
}
