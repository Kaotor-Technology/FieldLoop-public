import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page, request }) => {
  await page.context().clearCookies();
  await request.get("/test/reset");
});

test("viewer role can open a Bowtie in read-only mode", async ({ page }) => {
  await page.goto("/map");
  await expect(page.getByRole("heading", { name: "Scripted SSO" })).toBeVisible();
  await page.getByRole("link", { name: "Sign in as viewer" }).click();
  await expect(page.getByRole("heading", { name: "Geo Command Map", exact: true })).toBeVisible();

  await page.getByRole("button", { name: /Bowtie A/ }).click();
  await expect(page.getByRole("heading", { name: /Pipeline integrity/ })).toBeVisible();
  await expect(page.locator(".bowtie-header .eyebrow")).toContainText("READ-ONLY VIEW");
  await expect(page.locator(".bowtie-screen form")).toHaveCount(0);
  await expect(page.locator(".bowtie-screen input, .bowtie-screen select, .bowtie-screen textarea")).toHaveCount(0);
  await expect(page.locator(".bowtie-screen button")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Back to map" })).toBeVisible();
});
