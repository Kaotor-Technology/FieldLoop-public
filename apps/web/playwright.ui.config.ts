import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e", testMatch: ["ui-components.spec.ts", "health-proposal-review.spec.ts"], workers: 1, retries: 0,
  use: { baseURL: "http://127.0.0.1:4179", trace: "retain-on-failure" },
  webServer: { command: "pnpm exec vite --host 127.0.0.1 --port 4179", url: "http://127.0.0.1:4179/ui-preview.html", reuseExistingServer: false },
});
