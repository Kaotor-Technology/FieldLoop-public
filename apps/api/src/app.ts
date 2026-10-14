import { registerActionRoutes } from "./actions/routes.js";
import type { ActionServicePort } from "@fieldloop/adapters";
import Fastify from "fastify";
import { registerSimulationRoutes } from "./simulation/routes.js";
import type { SimulationPort } from "./simulation/client.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { UnavailableAuthService } from "./auth/runtime.js";
import type { AuthServicePort } from "./auth/service.js";
import { registerMapLayerRoutes, UnavailableMapLayerStore, type MapLayerStore } from "./map/layers.js";
import type { LoadedDomainPack } from "@fieldloop/adapters";
import { registerRiskRoutes } from "./risk/routes.js";
import type { RiskApiPort } from "./risk/service.js";
import { registerHealthRoutes } from "./health/routes.js";
import type { HealthServicePort } from "./health/model.js";
import { registerLiveEventRoute } from "./live-events.js";

declare module "fastify" {
  interface FastifyInstance {
    fieldLoopAuth: AuthServicePort;
    domainPacks: readonly LoadedDomainPack[];
  }
}

export function buildApp(options: {
  actions?: ActionServicePort;
  auth?: AuthServicePort;
  baseUrl?: string;
  mapLayers?: MapLayerStore;
  mapsApiKey?: string;
  simulator?: SimulationPort;
  risk?: RiskApiPort;
  health?: HealthServicePort;
  domainPacks?: LoadedDomainPack[];
} = {}) {
  const app = Fastify({ logger: { serializers: { req: serializeRequestForLog } } });
  const auth = options.auth ?? new UnavailableAuthService();
  app.decorate("fieldLoopAuth", auth);
  app.decorate("domainPacks", options.domainPacks ?? []);
  app.get("/healthz", async () => ({ status: "ok" }));
  // Cloud Run reserves some paths ending in z; use this route for remote probes.
  app.get("/health", async () => ({ status: "ok" }));
  registerAuthRoutes(app, auth, options.baseUrl ?? process.env["FIELDLOOP_BASE_URL"]);
  registerMapLayerRoutes(app, options.mapLayers ?? new UnavailableMapLayerStore(), options.mapsApiKey ?? process.env["FIELDLOOP_MAPS_API_KEY"]);
  registerSimulationRoutes(app, options.simulator);
  registerRiskRoutes(app, options.risk);
  registerHealthRoutes(app, options.health);
  registerActionRoutes(app, options.actions);
  registerLiveEventRoute(app, options.simulator, options.health, options.risk);
  return app;
}

// Query strings carry the OIDC authorization code and state on /api/auth/callback.
export function serializeRequestForLog(request: { method: string; url: string; host: string; ip: string }) {
  return { method: request.method, url: request.url.split("?", 1)[0] ?? "", host: request.host, remoteAddress: request.ip };
}
