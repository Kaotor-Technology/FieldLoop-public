import Fastify from "fastify";
import { registerSimulationRoutes } from "./simulation/routes.js";
import type { SimulationPort } from "./simulation/client.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { UnavailableAuthService } from "./auth/runtime.js";
import type { AuthServicePort } from "./auth/service.js";

declare module "fastify" {
  interface FastifyInstance {
    fieldLoopAuth: AuthServicePort;
  }
}

export function buildApp(options: { auth?: AuthServicePort; baseUrl?: string; simulator?: SimulationPort } = {}) {
  const app = Fastify({ logger: { serializers: { req: serializeRequestForLog } } });
  const auth = options.auth ?? new UnavailableAuthService();
  app.decorate("fieldLoopAuth", auth);
  app.get("/healthz", async () => ({ status: "ok" }));
  // Cloud Run reserves some paths ending in z; use this route for remote probes.
  app.get("/health", async () => ({ status: "ok" }));
  registerAuthRoutes(app, auth, options.baseUrl ?? process.env["FIELDLOOP_BASE_URL"]);
  registerSimulationRoutes(app, options.simulator);
  return app;
}

// Query strings carry the OIDC authorization code and state on /api/auth/callback.
export function serializeRequestForLog(request: { method: string; url: string; host: string; ip: string }) {
  return { method: request.method, url: request.url.split("?", 1)[0] ?? "", host: request.host, remoteAddress: request.ip };
}
