import Fastify from "fastify";

export function buildApp() {
  const app = Fastify({ logger: true });
  app.get("/healthz", async () => ({ status: "ok" }));
  // Cloud Run reserves some paths ending in z; use this route for remote probes.
  app.get("/health", async () => ({ status: "ok" }));
  return app;
}
