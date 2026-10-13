import { isRunCreate, isPlayerCommand } from "@fieldloop/contracts";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { CurrentUser } from "../auth/service.js";
import { SimulationError, type PlayerCommand, type RunCreate, type SimulationPort, type SimulationRun } from "./client.js";
import type { RiskApiPort } from "../risk/service.js";

const classes = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED"];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function permits(user: CurrentUser, classification: string): boolean {
  const ceiling = classes.indexOf(user.clearance);
  const level = classes.indexOf(classification);
  return ceiling >= 0 && level >= 0 && ceiling >= level;
}

export function registerSimulationRoutes(app: FastifyInstance, simulator?: SimulationPort, risk?: RiskApiPort): void {
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
      const user = request.fieldLoopCurrentUser;
      const isEventStream = request.routeOptions.url === "/api/v1/events";
      if (!isEventStream && !simulator) throw new SimulationError(503, "simulation_unavailable");
      if (isEventStream && !simulator && !risk) throw new SimulationError(503, "simulation_unavailable");
      if (!user || (!isEventStream && simulator && user.orgId !== simulator.orgId)) throw new SimulationError(403, "organisation_denied");
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
    routes.get("/api/v1/events", async (request, reply) => {
      const abort = new AbortController();
      reply.raw.on("close", () => abort.abort());
      const user = currentUser(request);
      const canStreamSimulation = simulator?.orgId === user.orgId;
      let previous = canStreamSimulation ? checked(request, await port().current(abort.signal)) : null;
      const lastEventId = request.headers["last-event-id"];
      let riskCursor = parseRiskCursor(typeof lastEventId === "string" ? lastEventId : undefined);
      if (!riskCursor) riskCursor = { createdAt: new Date(Date.now() - 2000).toISOString(), id: "00000000-0000-0000-0000-000000000000" };
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream", "Cache-Control": "private, no-store",
        "X-Accel-Buffering": "no", Connection: "keep-alive",
      });
      reply.raw.write("retry: 1000\n\n");
      const started = Date.now();
      let lastValidated = started;
      let firstEvent = true;
      try {
        while (!abort.signal.aborted && Date.now() - started < 45_000) {
          const current = canStreamSimulation ? checked(request, await port().current(abort.signal)) : null;
          if (current) {
            const reset = (previous && current.id !== previous.id) || (
              firstEvent && typeof request.headers["last-event-id"] === "string" && request.headers["last-event-id"].split(":")[0] !== current.id
            );
            const cursor = risk && riskCursor ? `|risk:${riskCursor.createdAt}:${riskCursor.id}` : "";
            const payload = `id: ${current.id}:${current.revision}${cursor}\nevent: ${reset ? "simulation.reset" : "simulation.state"}\ndata: ${JSON.stringify(current)}\n\n`;
            if (!reply.raw.write(payload)) await once(reply.raw, "drain", { signal: abort.signal });
          } else reply.raw.write(": idle\n\n");
          previous = current;
          firstEvent = false;
          if (risk) {
            const events = await risk.riskEventsAfter(currentUser(request), riskCursor);
            for (const event of events) {
              const eventId = `${canStreamSimulation && previous ? `${previous.id}:${previous.revision}|` : ""}risk:${event.createdAt}:${event.id}`;
              const payload = `id: ${eventId}\nevent: risk.recalculated\ndata: ${JSON.stringify(event)}\n\n`;
              if (!reply.raw.write(payload)) await once(reply.raw, "drain", { signal: abort.signal });
              riskCursor = { createdAt: event.createdAt, id: event.id };
            }
          }
          await delay(500, undefined, { signal: abort.signal });
          // Revalidate server-side session while streaming. Tokens never go to the browser.
          if (Date.now() - lastValidated >= 5000) {
            const user = await app.fieldLoopAuth.getCurrentUser(request.cookies["fl_session"], false);
            if (user.orgId !== currentUser(request).orgId) throw new SimulationError(403, "organisation_denied");
            request.fieldLoopCurrentUser = user;
            lastValidated = Date.now();
          }
        }
      } catch (error) {
        if (!abort.signal.aborted) request.log.warn({ errorType: error instanceof Error ? error.name : "unknown" }, "Simulation stream ended");
      } finally {
        abort.abort();
        reply.raw.end();
      }
    });
  });
}

function parseRiskCursor(value: string | undefined): { createdAt: string; id: string } | null {
  if (!value) return null;
  const match = /(?:^|\|)risk:(.+):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(value);
  if (!match?.[1] || !match[2] || !Number.isFinite(new Date(match[1]).getTime())) return null;
  return { createdAt: match[1], id: match[2] };
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
