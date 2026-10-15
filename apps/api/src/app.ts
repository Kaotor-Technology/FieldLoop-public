import { registerAssistantRoutes } from "./assistant/routes.js";
import type { AssistantPort } from "./assistant/client.js";
import { registerActionRoutes } from "./actions/routes.js";
import type { ActionDecisionPort, ActionServicePort } from "@fieldloop/adapters";
import { registerCommandPackageRoutes } from "./command-packages/routes.js";
import type { CommandPackageServicePort } from "@fieldloop/adapters";
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
import { registerAuditRoutes } from "./audit/routes.js";
import type { AuditServicePort } from "./audit/model.js";
import { registerHealthRoutes } from "./health/routes.js";
import type { HealthServicePort } from "./health/model.js";
import { registerLiveEventRoute } from "./live-events.js";
import { registerGeoReferenceRoutes } from "./geo-references/routes.js";
import type { GeoReferenceStore } from "./geo-references/model.js";
import { registerImportRoutes } from "./imports/routes.js";
import type { ImportPort } from "./imports/store.js";

declare module "fastify" {
  interface FastifyInstance {
    fieldLoopAuth: AuthServicePort;
    domainPacks: readonly LoadedDomainPack[];
  }
}

export function buildApp(options: {
  assistant?: AssistantPort;
  actions?: ActionServicePort & ActionDecisionPort;
  commandPackages?: CommandPackageServicePort;
  audit?: AuditServicePort;
  auth?: AuthServicePort;
  baseUrl?: string;
  mapLayers?: MapLayerStore;
  mapsApiKey?: string;
  simulator?: SimulationPort;
  risk?: RiskApiPort;
  health?: HealthServicePort;
  geoReferences?: GeoReferenceStore;
  domainPacks?: LoadedDomainPack[];
  imports?: ImportPort;
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
  registerAssistantRoutes(app, options.assistant);
  registerRiskRoutes(app, options.risk);
  registerHealthRoutes(app, options.health);
  registerImportRoutes(app, options.imports);
  registerAuditRoutes(app, options.audit);
  registerActionRoutes(app, options.actions);
  registerCommandPackageRoutes(app, options.commandPackages);
  registerGeoReferenceRoutes(app, options.geoReferences, options.baseUrl ?? process.env["FIELDLOOP_BASE_URL"]);
  registerLiveEventRoute(app, options.simulator, options.health, options.risk);
  return app;
}

// Query strings carry the OIDC authorization code and state on /api/auth/callback.
export function serializeRequestForLog(request: { method: string; url: string; host: string; ip: string }) {
  return { method: request.method, url: request.url.split("?", 1)[0] ?? "", host: request.host, remoteAddress: request.ip };
}
