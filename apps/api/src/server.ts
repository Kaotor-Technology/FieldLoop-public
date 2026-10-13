import { simulationClientFromEnvironment } from "./simulation/client.js";
import { buildApp } from "./app.js";
import { createProductionAuthRuntime } from "./auth/runtime.js";
import { registerSpa } from "./spa.js";
import { registerReference } from "./reference.js";
import { fileURLToPath } from "node:url";
import { loadDemoDomainPacks } from "./domain-packs.js";

// Validate every required file before opening any connections or listening.
const domainPacks = await loadDemoDomainPacks();
const authRuntime = await createProductionAuthRuntime();
const simulator = simulationClientFromEnvironment();
try {
  if (authRuntime.registerPacks) await authRuntime.registerPacks(domainPacks);
} catch (error) {
  await authRuntime.close();
  throw error;
}
const app = buildApp({
  auth: authRuntime.auth,
  mapLayers: authRuntime.mapLayers,
  domainPacks,
  ...(simulator ? { simulator } : {}),
  ...(process.env["FIELDLOOP_BASE_URL"] ? { baseUrl: process.env["FIELDLOOP_BASE_URL"] } : {}),
});
app.addHook("onClose", authRuntime.close);
app.log.info({ packs: domainPacks.map(({ content }) => `${content.id}@${content.version}`), persisted: Boolean(authRuntime.registerPacks) }, "Domain Packs loaded");
const port = Number(process.env["PORT"] ?? "8080");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

// The web-api image serves the built SPA from the same origin.
await registerReference(app, fileURLToPath(new URL("reference/", import.meta.resolve("@fieldloop/contracts"))));
await registerSpa(app, fileURLToPath(new URL("../../web/dist/", import.meta.url)));

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
