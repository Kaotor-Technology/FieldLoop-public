import { buildApp } from "./app.js";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";

const app = buildApp();
const port = Number(process.env["PORT"] ?? "8080");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

// The web-api image serves the built SPA from the same origin.
await app.register(fastifyStatic, {
  root: fileURLToPath(new URL("../../web/dist/", import.meta.url)),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.close().catch((error: unknown) => {
      app.log.error(error);
      process.exitCode = 1;
    });
  });
}

try {
  await app.listen({ host: "0.0.0.0", port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
