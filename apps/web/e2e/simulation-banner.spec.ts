import { expect, test } from "@playwright/test";

test("scenario definitions do not start a run and visible simulated data stays labeled", async ({ request, page }) => {
  await request.get("/test/reset");
  await page.goto("/map");
  await page.getByRole("link", { name: "Sign in as operator" }).click();
  await page.getByLabel("Scenario", { exact: true }).click();
  await expect(page.getByRole("option", { name: "Player verification fixture", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".workspace-banner")).toHaveText("SIMULATION · Simulated data");
  await expect(page.locator(".workspace-banner")).not.toContainText("Scenario:");
});
