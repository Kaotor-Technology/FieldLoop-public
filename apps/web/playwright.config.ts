import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e", workers: 1, retries: 0,
  use: { baseURL: "https://localhost:4173", ignoreHTTPSErrors: true, trace: "retain-on-failure" },
  webServer: { command: "node ../api/test/browser-server.mjs", url: "https://localhost:4173/health", ignoreHTTPSErrors: true, reuseExistingServer: false },
});
