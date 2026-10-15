import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", testMatch: "strip-band.browser.ts", workers: 1, retries: 0,
  outputDir: process.env["FL93_EVIDENCE_DIR"] ?? "test-results/strip-band",
  use: { baseURL: "http://127.0.0.1:4183", trace: "retain-on-failure" },
  webServer: { command: "pnpm exec vite --config vite.strip-fixture.config.ts --host 127.0.0.1 --port 4183", url: "http://127.0.0.1:4183/strip-band-fixture.html", reuseExistingServer: false },
});
