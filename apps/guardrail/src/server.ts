import { buildApp } from "./app.js";

import { loadGuardrailPolicies } from "./policies.js";

const aiSafety = await loadGuardrailPolicies();
const app = buildApp();
app.log.info({ aiSystem: aiSafety.aiSystem.id, policies: aiSafety.policies.map(({ id }) => id),
  mode: "enforce", failMode: "fail-closed" }, "Guardrail policy configuration loaded");
const port = Number(process.env["PORT"] ?? "8080");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

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
