import { expect, test } from "@playwright/test";

test("scenario definitions do not mark the workspace as currently simulated", async ({ request, page }) => {
  await request.get("/test/reset");
  await page.goto("/map");
  await page.getByRole("link", { name: "Sign in as operator" }).click();
  await page.getByLabel("Scenario", { exact: true }).click();
  await expect(page.getByRole("option", { name: "Player verification fixture", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".workspace-banner")).toContainText("SYNTHETIC");
  await expect(page.locator(".workspace-banner")).not.toContainText("SIMULATION");
});
