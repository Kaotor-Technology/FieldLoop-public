import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

export async function registerSpa(app: FastifyInstance, root: string): Promise<void> {
  await app.register(fastifyStatic, { root });
  // A direct SSO return to /map, or a reload of /audit, must load the SPA; missing API paths stay 404.
  for (const path of ["/map", "/audit"]) {
    app.get(path, async (_request, reply) => reply.header("cache-control", "no-store").sendFile("index.html"));
  }
}
