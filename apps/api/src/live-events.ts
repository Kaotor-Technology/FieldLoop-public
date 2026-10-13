import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { CurrentUser } from "./auth/service.js";
import type { EventPosition, HealthServicePort } from "./health/model.js";
import type { SimulationPort, SimulationRun } from "./simulation/client.js";

interface SimulationPosition { id: string; revision: number; }
interface StreamCursor { health: EventPosition | null; simulation: SimulationPosition | null; }
const classes = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED"];

export function registerLiveEventRoute(app: FastifyInstance, simulator?: SimulationPort, health?: HealthServicePort): void {
  app.get("/api/v1/events", async (request, reply) => {
    let user = request.fieldLoopCurrentUser;
    if (!user) return sendProblem(reply, 401, "unauthenticated");
    if (!simulator && !health) return sendProblem(reply, 503, "service_unavailable");
    if (simulator && simulator.orgId !== user.orgId) return sendProblem(reply, 403, "forbidden");
    const rawCursor = request.headers["last-event-id"];
    const parsed = typeof rawCursor === "string" ? parseCursor(rawCursor) : null;
    if (typeof rawCursor === "string" && !parsed) return sendProblem(reply, 400, "validation_failed");
    let healthPosition = parsed?.health ?? (health ? await health.latestEventPosition() : null);
    let simulationPosition = parsed?.simulation ?? null;
    let previous = simulator ? checked(user, await simulator.current()) : null;
    const abort = new AbortController();
    reply.raw.on("close", () => abort.abort());
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
        let emitted = false;
        if (simulator) {
          const current = checked(user, await simulator.current(abort.signal));
          if (current && (!simulationPosition || current.id !== simulationPosition.id || current.revision !== simulationPosition.revision)) {
            const reset = (previous && current.id !== previous.id) || (
              firstEvent && simulationPosition !== null && simulationPosition.id !== current.id
            );
            const cursor: StreamCursor = { health: healthPosition, simulation: { id: current.id, revision: current.revision } };
            await writeEvent(reply, abort.signal, encodeCursor(cursor), reset ? "simulation.reset" : "simulation.state", current);
            simulationPosition = cursor.simulation;
            emitted = true;
          }
          previous = current;
        }
        if (health) {
          const events = await health.listEvents(user, healthPosition, 50);
          for (const stored of events) {
            healthPosition = stored.position;
            const cursor: StreamCursor = { health: healthPosition, simulation: simulationPosition };
            await writeEvent(reply, abort.signal, encodeCursor(cursor), stored.event.type, stored.event);
            emitted = true;
          }
        }
        if (!emitted) {
          const cursor: StreamCursor = { health: healthPosition, simulation: simulationPosition };
          reply.raw.write(`id: ${encodeCursor(cursor)}\n: idle\n\n`);
        }
        firstEvent = false;
        await delay(500, undefined, { signal: abort.signal });
        if (Date.now() - lastValidated >= 5000) {
          const refreshed = await app.fieldLoopAuth.getCurrentUser(request.cookies["fl_session"], false);
          if (refreshed.orgId !== user.orgId) throw new Error("Organisation changed during the event stream");
          user = refreshed;
          request.fieldLoopCurrentUser = refreshed;
          lastValidated = Date.now();
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) request.log.warn({ errorType: error instanceof Error ? error.name : "unknown" }, "Live event stream ended");
    } finally {
      abort.abort();
      reply.raw.end();
    }
  });
}

async function writeEvent(reply: FastifyReply, signal: AbortSignal, id: string, type: string, data: unknown): Promise<void> {
  const payload = `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  if (!reply.raw.write(payload)) await once(reply.raw, "drain", { signal });
}
function checked(user: CurrentUser, run: SimulationRun | null): SimulationRun | null {
  if (!run) return null;
  const ceiling = classes.indexOf(user.clearance), level = classes.indexOf(run.classification);
  if (run.orgId !== user.orgId || ceiling < 0 || level < 0 || ceiling < level) throw new Error("Simulation access denied");
  return run;
}
function parseCursor(value: string): StreamCursor | null {
  const legacy = /^([0-9a-f-]{36}):(\d+)$/i.exec(value);
  if (legacy?.[1] && legacy[2]) {
    const revision = Number(legacy[2]);
    if (Number.isSafeInteger(revision)) return { health: null, simulation: { id: legacy[1], revision } };
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || !("health" in parsed) || !("simulation" in parsed)) return null;
    const candidate = parsed as { health: unknown; simulation: unknown };
    if (candidate.health !== null && !isPosition(candidate.health)) return null;
    if (candidate.simulation !== null && (!candidate.simulation || typeof candidate.simulation !== "object"
      || !("id" in candidate.simulation) || !("revision" in candidate.simulation)
      || typeof candidate.simulation.id !== "string" || !/^[0-9a-f-]{36}$/i.test(candidate.simulation.id)
      || !Number.isSafeInteger(candidate.simulation.revision) || Number(candidate.simulation.revision) < 0)) return null;
    return { health: candidate.health as EventPosition | null, simulation: candidate.simulation as SimulationPosition | null };
  } catch { return null; }
}
function isPosition(value: unknown): value is EventPosition {
  if (!value || typeof value !== "object" || !("createdAt" in value) || !("id" in value)) return false;
  return typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt))
    && typeof value.id === "string" && /^[0-9a-f-]{36}$/i.test(value.id);
}
function encodeCursor(cursor: StreamCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
function sendProblem(reply: FastifyReply, status: number, code: string) {
  return reply.code(status).type("application/problem+json").send({ type: "about:blank", title: code, status, code });
}
