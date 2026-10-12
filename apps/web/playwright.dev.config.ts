import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  use: { ...base.use, baseURL: "https://localhost:5173" },
  webServer: {
    command: "node e2e/dev-server.mjs", url: "https://localhost:5173/map",
    ignoreHTTPSErrors: true, reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
  },
});
