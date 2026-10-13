import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { CurrentUser } from "../auth/service.js";
import { RiskServiceError, type RiskApiPort } from "./service.js";

export function registerRiskRoutes(app: FastifyInstance, risk?: RiskApiPort): void {
  app.register(async (routes) => {
    routes.setErrorHandler((error: unknown, request, reply) => {
      if (error instanceof RiskServiceError) return sendProblem(reply, error.status, error.code);
      const status = (error as { statusCode?: number } | null)?.statusCode;
      if (status && status >= 400 && status < 500) return sendProblem(reply, 400, "validation_failed");
      request.log.error({ errorType: error instanceof Error ? error.name : "unknown" }, "Risk request failed");
      return sendProblem(reply, 503, "risk_service_unavailable");
    });
    routes.addHook("preHandler", async (_request, reply) => {
      reply.header("cache-control", "private, no-store");
      if (!risk) throw new RiskServiceError(503, "risk_service_unavailable");
    });
    const service = (): RiskApiPort => {
      if (!risk) throw new RiskServiceError(503, "risk_service_unavailable");
      return risk;
    };
    routes.get("/api/v1/bowties", async (request) => service().listBowties(currentUser(request)));
    routes.get("/api/v1/bowties/:bowtieId", async (request) => service().getBowtie(currentUser(request), bowtieId(request)));
    routes.get("/api/v1/bowties/:bowtieId/risk", async (request) => service().getRisk(currentUser(request), bowtieId(request)));
    routes.get("/api/v1/bowties/:bowtieId/risk/explain", async (request) => service().explain(currentUser(request), bowtieId(request)));
    routes.get("/api/v1/evidence/:evidenceId", async (request) => service().getEvidence(currentUser(request), uuidParam(request, "evidenceId")));
  });
}

function currentUser(request: FastifyRequest): CurrentUser {
  if (!request.fieldLoopCurrentUser) throw new RiskServiceError(401, "session_required");
  return request.fieldLoopCurrentUser;
}

function bowtieId(request: FastifyRequest): string { return uuidParam(request, "bowtieId"); }

function uuidParam(request: FastifyRequest, field: string): string {
  const params = request.params as Record<string, string>;
  const value = params[field];
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new RiskServiceError(400, "validation_failed");
  }
  return value;
}

function sendProblem(reply: FastifyReply, status: number, code: string) {
  const titles: Record<string, string> = {
    risk_matrix_unconfigured: "Organisation Risk Matrix is not approved",
    risk_matrix_invalid: "Organisation risk calibration is invalid",
    risk_input_invalid: "Risk inputs could not be validated",
    risk_service_unavailable: "Risk service is temporarily unavailable",
    clearance_denied: "Access is not permitted",
    not_found: "Requested record was not found",
    validation_failed: "Request could not be processed",
  };
  return reply.code(status).type("application/problem+json").send({
    type: "about:blank", status, title: titles[code] ?? "Risk request could not be completed", code,
  });
}
