import createClient from "openapi-fetch";
import { isSimulationRun, isScenarioSummary } from "@fieldloop/contracts";
import type { components, paths } from "@fieldloop/contracts";
import { createCloudRunFetch } from "@fieldloop/adapters";

export type SimulationRun = components["schemas"]["SimulationRun"];
export type ScenarioSummary = components["schemas"]["ScenarioSummary"];
export type RunCreate = components["schemas"]["RunCreate"];
export type PlayerCommand = components["schemas"]["PlayerCommand"];
export type Command = "play" | "pause" | "step" | "speed" | "bookmark" | "reset";
export interface SimulationPort {
  orgId: string;
  scenarios(signal?: AbortSignal): Promise<ScenarioSummary[]>;
  current(signal?: AbortSignal): Promise<SimulationRun | null>;
  read(id: string, signal?: AbortSignal): Promise<SimulationRun>;
  create(body: RunCreate, key: string): Promise<SimulationRun>;
  command(id: string, command: Command, body: PlayerCommand, key: string): Promise<SimulationRun>;
}

export class SimulationError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

const commandPaths = {
  play: "/v1/simulation/runs/{runId}:play",
  pause: "/v1/simulation/runs/{runId}:pause",
  step: "/v1/simulation/runs/{runId}:step",
  speed: "/v1/simulation/runs/{runId}:speed",
  bookmark: "/v1/simulation/runs/{runId}:bookmark",
  reset: "/v1/simulation/runs/{runId}:reset",
} as const;

export class RemoteSimulationClient implements SimulationPort {
  private readonly client;
  constructor(baseUrl: string, readonly orgId: string, serviceFetch: (request: Request) => Promise<Response>) {
    this.client = createClient<paths>({ baseUrl, fetch: serviceFetch });
  }
  async scenarios(signal = AbortSignal.timeout(30_000)): Promise<ScenarioSummary[]> {
    const items = unwrap(await this.client.GET("/v1/scenarios", { signal: bounded(signal) }));
    if (!Array.isArray(items) || !items.every((item) => isScenarioSummary(item))) throw new SimulationError(503, "invalid_simulation_response");
    return items;
  }
  async current(signal = AbortSignal.timeout(30_000)): Promise<SimulationRun | null> {
    const result = await this.client.GET("/v1/simulation/runs/current", { signal: bounded(signal) });
    if (!result.response.ok || result.data === undefined) throw upstreamError(result.response.status);
    if (result.data !== null && !isSimulationRun(result.data)) throw new SimulationError(503, "invalid_simulation_response");
    return result.data;
  }
  async read(id: string, signal = AbortSignal.timeout(30_000)): Promise<SimulationRun> {
    return checkedRun(unwrap(await this.client.GET("/v1/simulation/runs/{runId}", { params: { path: { runId: id } }, signal: bounded(signal) })));
  }
  async create(body: RunCreate, key: string): Promise<SimulationRun> {
    return checkedRun(unwrap(await this.client.POST("/v1/simulation/runs", {
      body, params: { header: { "X-CSRF-Token": "internal", "Idempotency-Key": key } }, signal: AbortSignal.timeout(30_000),
    })));
  }
  async command(id: string, command: Command, body: PlayerCommand, key: string): Promise<SimulationRun> {
    return checkedRun(unwrap(await this.client.POST(commandPaths[command], {
      body, params: { path: { runId: id }, header: { "X-CSRF-Token": "internal", "Idempotency-Key": key } }, signal: AbortSignal.timeout(30_000),
    })));
  }
}

function upstreamError(status: number): SimulationError {
  // Do not expose upstream exception bodies or service identity responses to the browser.
  const safeStatus = [400, 404, 409].includes(status) ? status : 503;
  return new SimulationError(safeStatus, safeStatus === 503 ? "simulation_unavailable" : "simulation_request_failed");
}
function unwrap<T>(result: { data?: T; response: Response }): T {
  if (!result.response.ok || result.data === undefined) throw upstreamError(result.response.status);
  return result.data;
}

export function simulationClientFromEnvironment(): SimulationPort | undefined {
  const environment = process.env["FIELDLOOP_ENV"];
  const baseUrl = process.env["FIELDLOOP_SIMULATOR_URL"];
  const orgId = process.env["FIELDLOOP_DEFAULT_ORG_ID"];
  if (!baseUrl || !orgId || !["dev", "demo", "local"].includes(environment ?? "")) return undefined;
  if (environment === "local") {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) throw new Error("Local simulator requires a loopback HTTP endpoint");
    return new RemoteSimulationClient(baseUrl, orgId, (request) => fetch(request, { redirect: "error" }));
  }
  return new RemoteSimulationClient(baseUrl, orgId, createCloudRunFetch(baseUrl));
}

function checkedRun(value: unknown): SimulationRun {
  if (!isSimulationRun(value)) throw new SimulationError(503, "invalid_simulation_response");
  return value;
}
function bounded(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
}
