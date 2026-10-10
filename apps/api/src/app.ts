import Fastify from "fastify";
import { registerAuthRoutes } from "./auth/routes.js";
import { UnavailableAuthService } from "./auth/runtime.js";
import type { AuthServicePort } from "./auth/service.js";

declare module "fastify" {
  interface FastifyInstance {
    fieldLoopAuth: AuthServicePort;
  }
}

export function buildApp(options: { auth?: AuthServicePort; baseUrl?: string } = {}) {
  const app = Fastify({ logger: true });
  const auth = options.auth ?? new UnavailableAuthService();
  app.decorate("fieldLoopAuth", auth);
  app.get("/healthz", async () => ({ status: "ok" }));
  // Cloud Run reserves some paths ending in z; use this route for remote probes.
  app.get("/health", async () => ({ status: "ok" }));
  registerAuthRoutes(app, auth, options.baseUrl ?? process.env["FIELDLOOP_BASE_URL"]);
  return app;
}
