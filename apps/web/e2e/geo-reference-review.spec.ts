import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function signInAsOperator(page: import("@playwright/test").Page) {
  await page.goto("/map");
  await expect(page.getByRole("heading", { name: "Scripted SSO" })).toBeVisible();
  await page.getByRole("link", { name: "Sign in as operator" }).click();
  await expect(page.getByRole("heading", { name: "Geo Command Map", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Geo Reference drafts", exact: true })).toBeVisible();
}

test.beforeEach(async ({ request }) => { await request.get("/test/reset"); });

test("Geo Reference review passes axe in English and Thai at 320, 390 and 1280", async ({ page }) => {
  await signInAsOperator(page);
  let language: "en" | "th" = "en";
  let theme: "light" | "dark" = "light";
  for (const nextLanguage of ["en", "th"] as const) {
    if (nextLanguage !== language) {
      await page.getByRole("button", { name: language === "en" ? "ภาษาไทย" : "English" }).click();
      language = nextLanguage;
    }
    for (const nextTheme of ["light", "dark"] as const) {
      if (nextTheme !== theme) {
        await page.getByRole("button", { name: language === "en" ? "Night shift" : "โหมดกะกลางคืน" }).click();
        theme = nextTheme;
        await page.waitForTimeout(250);
      }
      for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        const heading = language === "en" ? "Geo Reference drafts" : "Geo Reference ฉบับร่าง";
        await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
        const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        expect(horizontalOverflow, `${language}/${theme}/${width}: horizontal overflow`).toBe(false);
        const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
        expect(audit.violations, `${language}/${theme}/${width}: ${JSON.stringify(audit.violations)}`).toEqual([]);
      }
    }
  }
});

test("Geo Reference Draft exposes source, confidence, simulation label and keyboard decisions", async ({ page }) => {
  await signInAsOperator(page);
  const panel = page.getByRole("complementary", { name: "Map context panel" });
  const row = panel.locator(".geo-reference-row").filter({ hasText: "Synthetic valve marker" });
  await expect(row).toContainText("Valve marker at coordinates 13.756, 100.501.");
  await expect(row).toContainText("85%");
  await expect(row.getByText("SIMULATION", { exact: true })).toBeVisible();

  const confirm = row.getByRole("button", { name: "Confirm and place on map" });
  const reject = row.getByRole("button", { name: "Reject", exact: true });
  await confirm.focus();
  await page.keyboard.press("Tab");
  await expect(reject).toBeFocused();
  await expect.poll(() => reject.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
  await confirm.focus();
  const saved = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(":confirm"));
  await page.keyboard.press("Enter");
  const response = await saved;
  expect(response.status()).toBe(200);
  expect(response.request().headers()["x-csrf-token"]).toBeTruthy();
  expect(response.request().headers()["idempotency-key"]).toMatch(/^[A-Za-z0-9._:-]{16,128}$/);
  await expect(row).toHaveCount(0);
  const pinnedLayer = await page.evaluate(async () => {
    const response = await fetch("/api/v1/map/layers/geo-references?bbox=99,13,101,15&zoom=13");
    return { status: response.status, collection: await response.json() };
  });
  expect(pinnedLayer.status).toBe(200);
  expect(pinnedLayer.collection.features).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: "00000000-0000-4000-8000-000000000092",
      geometry: { type: "Point", coordinates: [100.501, 13.756] },
      properties: expect.objectContaining({
        featureKind: "geo_reference", geoReferenceId: "00000000-0000-4000-8000-000000000092",
      }),
    }),
  ]));
});

test("low-confidence ambiguous Thai place is flagged, stays off the map and cannot be confirmed without a target", async ({ page }) => {
  await signInAsOperator(page);
  const panel = page.getByRole("complementary", { name: "Map context panel" });
  const row = panel.locator(".geo-reference-row").filter({ hasText: "ท่าน้ำ" });
  await expect(row).toContainText("พบรอยรั่วใกล้ท่าน้ำ");
  await expect(row).toContainText("35%");
  await expect(row.getByText("Low confidence", { exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "Confirm and place on map" })).toBeDisabled();

  const layer = await page.evaluate(async () => {
    const response = await fetch("/api/v1/map/layers/geo-references?bbox=99,13,101,15&zoom=13");
    return { status: response.status, collection: await response.json() };
  });
  expect(layer.status).toBe(200);
  expect(layer.collection.features).toEqual([]);
});
