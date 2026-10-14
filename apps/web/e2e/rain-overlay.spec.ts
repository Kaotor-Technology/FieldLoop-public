import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { components } from "@fieldloop/contracts";
import { installOfflineMap } from "./fixtures/offline-map";
import { rainSnapshot } from "../test/fixtures/rain-replay";

type Run = components["schemas"]["SimulationRun"];
// Responses are snapshots exported from the real player, not invented rain data.
for (const theme of ["light", "dark"]) for (const width of [390, 1280]) {
  test(`FL-40 rain play/pause/step and accessibility ${theme} ${width}`, async ({ page, request }) => {
    await request.get("/test/reset");
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const externalRequests: string[] = [];
    await page.route("**/*", async (route) => {
      if (new URL(route.request().url()).hostname !== "localhost") {
        externalRequests.push(route.request().url());
        await route.abort();
      } else await route.fallback();
    });
    await installOfflineMap(page);
    await page.route("**/api/v1/map/layers/*?*", (route) => route.fulfill({ json: {
      type: "FeatureCollection", features: route.request().url().includes("/assets?") ? [{
        type: "Feature", id: "synthetic-zone-z3",
        geometry: { type: "Polygon", coordinates: [[[100.56, 13.76], [100.60, 13.76], [100.60, 13.79], [100.56, 13.79], [100.56, 13.76]]] },
        properties: { code: "Z3", name: "Demo drainage zone Z3 (SIMULATION)", featureKind: "area", domainPack: "flood-water", simulated: true, classification: "CONFIDENTIAL", health: null, riskBand: null },
      }] : [],
    } }));
    let current: Run | null = null;
    await page.route("**/api/v1/scenarios", (route) => route.fulfill({ json: [{ id: "bangkok-storm", name: "Demo B storm", version: "1.0.0", durationSeconds: 259200, simulated: true, classification: "CONFIDENTIAL" }] }));
    await page.route("**/api/v1/simulation/runs/current", (route) => route.fulfill({ json: current }));
    let step = 0;
    await page.route("**/api/v1/simulation/runs**", async (route) => {
      if (route.request().method() !== "POST") { await route.fallback(); return; }
      const command = route.request().url().split(":").at(-1);
      const name = command === "play" ? "playing" : command === "pause" ? "paused" : command === "reset" ? "reset"
        : command === "step" ? ["canalRising", "accumulation3600", "accumulation7200", "rainLeaves"][step++] : "ready";
      current = rainSnapshot(name ?? "");
      await route.fulfill({ json: current });
    });
    await page.goto("/map");
    await page.getByRole("link", { name: "Sign in as operator" }).click();
    if (theme === "dark") await page.getByRole("button", { name: "Night shift" }).click();
    const canvas = page.locator(".map-canvas canvas");
    const canvasImage = () => canvas.screenshot({ style: ".map-legend, .map-overlay-top, .map-overlay-top * { visibility: hidden !important; }" });
    await expect(canvas).toBeVisible();
    await page.getByLabel("Scenario", { exact: true }).click();
    await page.getByRole("option", { name: "Demo B storm", exact: true }).click();
    await page.getByRole("button", { name: "Create run", exact: true }).click();
    const legend = page.getByRole("heading", { name: "Scenario rainfall · SIMULATION", exact: true });
    await expect(legend).toHaveCount(0);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(legend).toBeVisible();
    await expect(page.locator(".workspace-banner")).toContainText("SIMULATION");
    const rainToggle = page.getByRole("checkbox", { name: "Scenario rain (SIMULATION)" });
    await rainToggle.focus();
    await page.keyboard.press("Space");
    await expect(legend).toHaveCount(0);
    const dryCanvas = await canvasImage();
    await rainToggle.focus();
    await page.keyboard.press("Space");
    await expect(legend).toBeVisible();
    await expect.poll(async () => (await canvasImage()).equals(dryCanvas)).toBe(false);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(legend).toBeVisible();
    for (const elapsed of [600, 3600, 7200]) {
      await page.getByRole("button", { name: "Step", exact: true }).click();
      await expect(page.getByRole("progressbar")).toHaveAttribute("value", String(elapsed));
      await expect(legend).toBeVisible();
    }
    await page.getByRole("button", { name: "Step", exact: true }).click();
    await expect(page.getByRole("progressbar")).toHaveAttribute("value", "7200");
    await expect(legend).toHaveCount(0);
    await expect.poll(async () => (await canvasImage()).equals(dryCanvas)).toBe(true);
    await page.getByRole("button", { name: "Reset simulation", exact: true }).click();
    await expect(page.getByRole("progressbar")).toHaveAttribute("value", "0");
    await expect(legend).toHaveCount(0);
    if (theme === "light" && width === 390) {
      await page.setViewportSize({ width: 320, height: 1000 });
      await page.getByRole("button", { name: "ภาษาไทย", exact: true }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    }
    if (theme === "light" && width === 1280) {
      await page.getByRole("button", { name: "Play", exact: true }).click();
      await expect(legend).toBeVisible();
      await page.screenshot({ path: "test-results/fl40-rain-playing.png", fullPage: true });
    }
    expect(externalRequests).toEqual([]);
  });

}
