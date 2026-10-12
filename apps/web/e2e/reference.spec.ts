import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.beforeEach(async ({ request }) => { await request.get("/test/reset"); });

test("reference navigation signs in, loads only same-origin assets, and revocation blocks downloads", async ({ page, request }) => {
  const origins = new Set<string>();
  page.on("request", (req) => origins.add(new URL(req.url()).origin));
  await page.goto("/api/reference/");
  await expect(page.getByRole("heading", { name: "Scripted SSO" })).toBeVisible();
  await page.getByRole("link", { name: "Sign in as viewer" }).click();
  await expect(page).toHaveURL(/\/api\/reference\/$/);
  await expect(page.getByRole("heading", { name: "FieldLoop API", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "GET /v1/me" })).toBeVisible();
  expect(origins).toEqual(new Set([new URL(page.url()).origin]));
  const spec = await page.request.get("/api/reference/openapi.json");
  expect(spec.status()).toBe(200);
  expect((await spec.json()).openapi).toBe("3.1.0");
  await request.get("/test/revoke");
  expect((await page.request.get("/api/reference/openapi.json")).status()).toBe(401);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Scripted SSO" })).toBeVisible();
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`reference supports keyboard/schema links and accessible ${colorScheme} layout at phone and desktop widths`, async ({ page }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.goto("/api/reference/");
    await page.getByRole("link", { name: "Sign in as viewer" }).click();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to reference" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#content")).toBeFocused();
    const schemaLink = page.locator('article a[href^="#ref-"]').first();
    await schemaLink.click();
    await expect.poll(() => page.evaluate(() => document.activeElement?.id === location.hash.slice(1))).toBe(true);
    for (const width of [320, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
    }
    await page.goto("/api/reference/");
    await page.screenshot({ path: `test-results/api-reference-${colorScheme}.png` });
  });
}
