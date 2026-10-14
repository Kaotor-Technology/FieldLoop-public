import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expectThaiTypography } from "./thai-typography";

test.beforeEach(async ({ request, page }) => {
  await request.get("/test/reset");
  await page.goto("/map");
  await page.getByRole("link", { name: "Sign in as operator" }).click();
  await expect(page.getByRole("heading", { name: "Geo Command Map", exact: true })).toBeVisible();
});

test("Thai toggle preserves URL, simulation selection and a typed Health Proposal reason", async ({ page }) => {
  await expect(page.getByRole("button", { name: "ภาษาไทย", exact: true })).toHaveText("EN / TH");
  await page.getByLabel("Scenario", { exact: true }).click();
  await page.getByRole("option", { name: "Player verification fixture", exact: true }).click();
  await page.getByLabel("Seed", { exact: true }).fill("94");
  const row = page.locator(".health-proposal-row").filter({ hasText: "SYNTHETIC-CP-01" });
  await row.getByRole("button", { name: "Accept Health Proposal for SYNTHETIC-CP-01" }).click();
  await row.getByRole("textbox", { name: "Decision reason" }).fill("เหตุผลจากการตรวจข้อมูลสังเคราะห์");
  const url = page.url();
  await page.getByRole("button", { name: "ภาษาไทย", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("lang", "th");
  await expect(page.getByRole("heading", { name: "แผนที่บัญชาการเชิงพื้นที่", exact: true })).toBeVisible();
  await expect(page.locator(".map-legend")).toContainText("ขัดข้อง");
  await expect(page.getByRole("heading", { name: "ตัวควบคุมสถานการณ์จำลอง", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "English", exact: true })).toHaveText("EN / TH");
  await expect(page.getByLabel("สถานการณ์จำลอง", { exact: true })).toContainText("Player verification fixture");
  await expect(page.getByLabel("ค่า seed", { exact: true })).toHaveValue("94");
  await expect(row.getByRole("textbox", { name: "เหตุผลในการตัดสินใจ" })).toHaveValue("เหตุผลจากการตรวจข้อมูลสังเคราะห์");
  await expect(row.getByRole("group", { name: "การเปลี่ยน Health ของ Barrier ที่เสนอ" })).toContainText("เสื่อมสภาพ");
  expect(page.url()).toBe(url);
  await expect(page.getByRole("button", { name: "English", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(row.getByRole("textbox", { name: "Decision reason" })).toHaveValue("เหตุผลจากการตรวจข้อมูลสังเคราะห์");
  await expect(page.getByLabel("Seed", { exact: true })).toHaveValue("94");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});

test("language survives reload and account switching without sharing one user's preference", async ({ page }) => {
  await page.getByRole("button", { name: "ภาษาไทย", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("heading", { name: "แผนที่บัญชาการเชิงพื้นที่", exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "th");
  expect(await page.evaluate(() => Object.values(localStorage))).toEqual(["th"]);
  await page.locator(".account-switcher > summary").click();
  await page.getByRole("button", { name: "ออกจากระบบและเปลี่ยนบัญชี", exact: true }).click();
  await page.getByRole("link", { name: "Confirm logout" }).click();
  await page.getByRole("link", { name: "Sign in as viewer" }).click();
  await expect(page.getByRole("heading", { name: "Geo Command Map", exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.locator(".account-switcher > summary").click();
  await page.getByRole("button", { name: "Sign out and change account", exact: true }).click();
  await page.getByRole("link", { name: "Confirm logout" }).click();
  await page.getByRole("link", { name: "Sign in as operator" }).click();
  await expect(page.getByRole("heading", { name: "แผนที่บัญชาการเชิงพื้นที่", exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "th");
});

test("searchable Scenario selection exposes Thai popup labels and an empty result", async ({ page }) => {
  await page.route("**/api/v1/scenarios", async (route) => {
    await route.fulfill({ json: Array.from({ length: 11 }, (_, index) => ({ id: `synthetic-scenario-${index}`, name: `SYNTHETIC Scenario ${index}` })) });
  });
  await page.reload();
  await page.getByRole("button", { name: "ภาษาไทย", exact: true }).click();
  await page.getByLabel("สถานการณ์จำลอง", { exact: true }).click();
  const search = page.getByRole("combobox", { name: "ค้นหาตัวเลือก", exact: true });
  await expect(search).toBeFocused();
  await expect(page.locator(".fl-select-menu")).toHaveAttribute("lang", "th");
  await search.fill("ไม่พบ");
  await expect(page.locator(".fl-select-menu").getByRole("status")).toContainText("ไม่มีตัวเลือกที่ตรงกัน");
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("สถานการณ์จำลอง", { exact: true })).toBeFocused();
});

test("long Thai Scenario labels remain visible in the picker at 320px", async ({ page }) => {
  const longScenarioName = "สถานการณ์จำลองเพื่อประเมินความเสี่ยงของสินทรัพย์และแนวป้องกันในพื้นที่เมืองที่มีฝนตกหนักต่อเนื่อง";
  await page.setViewportSize({ width: 320, height: 900 });
  await page.route("**/api/v1/scenarios", async (route) => {
    await route.fulfill({ json: Array.from({ length: 11 }, (_, index) => ({
      id: `synthetic-scenario-${index}`, name: index === 0 ? longScenarioName : `SYNTHETIC Scenario ${index}`,
    })) });
  });
  await page.reload();
  await page.getByRole("button", { name: "ภาษาไทย", exact: true }).click();
  const scenario = page.getByLabel("สถานการณ์จำลอง", { exact: true });
  await scenario.click();
  await page.getByRole("option", { name: longScenarioName, exact: true }).click();
  await expect(scenario).toContainText(longScenarioName);
  const metrics = await scenario.evaluate((button) => {
    const buttonRect = button.getBoundingClientRect();
    const label = button.childNodes[0];
    if (!label) throw new Error("Expected the Scenario label to be the first trigger child.");
    const range = document.createRange();
    range.selectNodeContents(label);
    const labelRect = range.getBoundingClientRect();
    return {
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      buttonWidth: button.clientWidth,
      buttonScrollWidth: button.scrollWidth,
      labelLeft: labelRect.left,
      labelRight: labelRect.right,
      buttonLeft: buttonRect.left,
      buttonRight: buttonRect.right,
    };
  });
  expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
  expect(metrics.buttonScrollWidth).toBeLessThanOrEqual(metrics.buttonWidth);
  expect(metrics.labelLeft).toBeGreaterThanOrEqual(metrics.buttonLeft);
  expect(metrics.labelRight).toBeLessThanOrEqual(metrics.buttonRight);
});

for (const colorScheme of ["light", "dark"] as const) for (const width of [390, 1280]) {
  test(`Thai demo accessibility and typography: ${colorScheme}, ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    // The app samples the system colour preference when the store is created.
    await page.reload();
    await page.getByRole("button", { name: "ภาษาไทย", exact: true }).click();
    await page.locator(".account-switcher > summary").click();
    await expect(page.locator("html")).toHaveAttribute("lang", "th");
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
    await expectThaiTypography(page);
    await page.setViewportSize({ width: 640, height: 450 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(640);
    await page.setViewportSize({ width: 320, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    if (width === 1280) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator(".account-switcher > summary").click();
      await page.screenshot({ path: `e2e/evidence/fl-94-thai-${colorScheme}.png`, fullPage: true });
    }
  });
}
