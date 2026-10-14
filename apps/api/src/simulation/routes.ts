import { isRunCreate, isPlayerCommand } from "@fieldloop/contracts";
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { CurrentUser } from "../auth/service.js";
import { SimulationError, type PlayerCommand, type RunCreate, type SimulationPort, type SimulationRun } from "./client.js";

const classes = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED"];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function permits(user: CurrentUser, classification: string): boolean {
  const ceiling = classes.indexOf(user.clearance);
  const level = classes.indexOf(classification);
  return ceiling >= 0 && level >= 0 && ceiling >= level;
}

export function registerSimulationRoutes(app: FastifyInstance, simulator?: SimulationPort): void {
  app.register(async (routes) => {
    routes.setErrorHandler((error: unknown, request, reply) => {
      if (error instanceof SimulationError) return problem(reply, error.status, error.code);
      const framework = (error as { statusCode?: number } | null)?.statusCode;
      if (framework && framework >= 400 && framework < 500) return problem(reply, 400, "validation_failed");
      request.log.error({ errorType: error instanceof Error ? error.name : "unknown" }, "Simulation service failed");
      return problem(reply, 503, "simulation_unavailable");
    });
    routes.addHook("preHandler", async (request, reply) => {
      reply.header("cache-control", "private, no-store");
      if (!simulator) throw new SimulationError(503, "simulation_unavailable");
      const user = request.fieldLoopCurrentUser;
      if (!user || user.orgId !== simulator.orgId) throw new SimulationError(403, "organisation_denied");
      if (request.method === "POST" && !user.roles.some((role) => ["fieldloop.operator", "fieldloop.manager"].includes(role))) {
        throw new SimulationError(403, "simulation_control_denied");
      }
    });
    const port = (): SimulationPort => {
      if (!simulator) throw new SimulationError(503, "simulation_unavailable");
      return simulator;
    };
    const checked = (request: FastifyRequest, run: SimulationRun | null): SimulationRun | null => {
      if (run && (run.orgId !== request.fieldLoopCurrentUser?.orgId || !permits(currentUser(request), run.classification))) throw new SimulationError(403, "clearance_denied");
      return run;
    };
    routes.get("/api/v1/scenarios", async (request) => (await port().scenarios()).filter((scenario) => permits(currentUser(request), scenario.classification)));
    routes.get("/api/v1/simulation/runs/current", async (request) => checked(request, await port().current()));
    routes.get("/api/v1/simulation/runs/:runId", async (request) => checked(request, await port().read(runId(request))));
    routes.post("/api/v1/simulation/runs", async (request) => {
      const key = idempotencyKey(request);
      if (!isRunCreate(request.body)) throw new SimulationError(400, "validation_failed");
      const body: RunCreate = request.body;
      checked(request, await port().current());
      const available = await port().scenarios();
      const scenario = available.find((s) => s.id === body?.scenarioId);
      if (!scenario) throw new SimulationError(404, "scenario_not_found");
      if (!permits(currentUser(request), scenario.classification)) throw new SimulationError(403, "clearance_denied");
      return checked(request, await port().create(body, key));
    });
    for (const command of ["play", "pause", "step", "speed", "bookmark", "reset"] as const) {
      routes.post(`/api/v1/simulation/runs/:runId([0-9a-fA-F-]{36})::${command}`, async (request) => {
        const id = runId(request);
        const key = idempotencyKey(request);
        // Read current, rather than the retired path, so a retry of reset can reach its cache.
        const run = checked(request, await port().current());
        if (!run) throw new SimulationError(404, "run_not_found");
        if (!isPlayerCommand(request.body)) throw new SimulationError(400, "validation_failed");
        const body: PlayerCommand = request.body;
        return checked(request, await port().command(id, command, body, key));
      });
    }
  });
}

function currentUser(request: FastifyRequest): CurrentUser {
  if (!request.fieldLoopCurrentUser) throw new SimulationError(401, "session_required");
  return request.fieldLoopCurrentUser;
}
function runId(request: FastifyRequest): string {
  const id = (request.params as { runId: string }).runId;
  if (!uuidPattern.test(id)) throw new SimulationError(400, "invalid_run_id");
  return id;
}
function idempotencyKey(request: FastifyRequest): string {
  const key = request.headers["idempotency-key"];
  if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/.test(key)) throw new SimulationError(400, "invalid_idempotency_key");
  return createHash("sha256").update(JSON.stringify([currentUser(request).sub, key])).digest("hex");
}
function problem(reply: FastifyReply, status: number, code: string) {
  return reply.code(status).type("application/problem+json").send({ type: "about:blank", status, title: "Simulation request could not be completed", code });
}
