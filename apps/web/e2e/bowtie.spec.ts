import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expectThaiTypography } from "./thai-typography";

test.beforeEach(async ({ page, request }) => {
  await request.get("/test/reset");
  await page.goto("/map?fl84Viewport=preserved");
  await page.getByRole("link", { name: "Sign in as operator" }).click();
  await expect(page.getByRole("heading", { name: "Geo Command Map", exact: true })).toBeVisible();
});

for (const colorScheme of ["light", "dark"] as const) {
  for (const width of [390, 1280]) {
    test(`Bowtie canvas ${colorScheme} ${width}px layout and accessibility`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      if (colorScheme === "dark") await page.getByRole("button", { name: "Night shift" }).click();
      await page.getByRole("button", { name: /Bowtie A/ }).click();
      await expect(page.getByRole("heading", { name: /Pipeline integrity/ })).toBeVisible();
      await expect(page.locator(".bowtie-path-membership").filter({ hasText: /Paths: Jet fire near a High Consequence Area, Supply interruption, Environmental damage at a river crossing/ }).first()).toBeVisible();
      await expect(page.locator(".bowtie-top-event")).toBeInViewport();

      const layout = await page.locator(".bowtie-canvas").evaluate((element) => ({
        columns: getComputedStyle(element).gridTemplateColumns.split(" ").length,
        viewportWidth: element.parentElement?.clientWidth ?? 0,
        canvasWidth: element.parentElement?.scrollWidth ?? 0,
      }));
      expect(layout.columns).toBe(width < 840 ? 1 : 3);
      expect(layout.canvasWidth).toBeLessThanOrEqual(layout.viewportWidth);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

      const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      expect(axe.violations).toEqual([]);
      if (colorScheme === "light" && width === 390) {
        const summaries = page.locator(".bowtie-screen summary");
        const summaryCount = await summaries.count();
        const targetSizes = await page.locator(".bowtie-back-button, .bowtie-screen summary").evaluateAll((elements) => elements.map((element) => {
          const { width: targetWidth, height: targetHeight } = element.getBoundingClientRect();
          return { width: targetWidth, height: targetHeight };
        }));
        expect(targetSizes.every(({ width: targetWidth, height: targetHeight }) => targetWidth >= 44 && targetHeight >= 44)).toBe(true);
        await page.getByRole("button", { name: "Back to map" }).focus();
        for (let index = 0; index < summaryCount; index += 1) {
          await page.keyboard.press("Tab");
          await expect(summaries.nth(index)).toBeFocused();
          if (index === 0) {
            const hasVisibleFocus = await summaries.nth(index).evaluate((element) => {
              const style = getComputedStyle(element);
              return element.matches(":focus-visible") && style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0;
            });
            expect(hasVisibleFocus).toBe(true);
            await page.keyboard.press("Enter");
            await expect(page.locator(".bowtie-triad").first()).toHaveAttribute("open", "");
          }
          if (index === summaryCount - 1) {
            await page.keyboard.press("Enter");
            await expect(page.locator(".bowtie-text-equivalent")).toHaveAttribute("open", "");
          }
        }
      }
      if (colorScheme === "light" && width === 1280) {
        await page.screenshot({ path: "e2e/evidence/bowtie-canvas.png", fullPage: true });
      }
      await page.getByRole("button", { name: "ภาษาไทย", exact: true }).click();
      await expect(page.locator("#bowtie-title")).toHaveAttribute("lang", "en");
      await expect(page.locator(".bowtie-provenance")).toHaveText("ข้อมูลสังเคราะห์ (SYNTHETIC)");
      await expect(page.locator(".bowtie-metadata dd").last()).toHaveText("ลับ");
      const textEquivalent = page.locator(".bowtie-text-equivalent");
      if (await textEquivalent.getAttribute("open") === null) await textEquivalent.locator("summary").click();
      await expect(page.locator(".bowtie-text-equivalent")).toContainText("ระดับชั้นข้อมูล: ลับ");
      await expect(textEquivalent).toContainText("ที่มาข้อมูล: ข้อมูลสังเคราะห์ (SYNTHETIC)");
      await expectThaiTypography(page);
      const thaiAxe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      expect(thaiAxe.violations).toEqual([]);
      await textEquivalent.locator("summary").click();
      if (colorScheme === "light" && width === 1280) {
        await page.screenshot({ path: "e2e/evidence/bowtie-canvas-thai.png", fullPage: true });
      }
    });
  }
}

test("Thai layout reflows at 320px and the keyboard can return to the map", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByRole("button", { name: /Bowtie A/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".bowtie-screen")).toBeVisible();
  await page.getByRole("button", { name: "ภาษาไทย", exact: true }).click();
  await expect(page.locator("#bowtie-title")).toHaveAttribute("lang", "en");

  const reflow = await page.locator(".bowtie-screen").evaluate((element) => {
    const pathMembership = element.querySelector(".bowtie-path-membership");
    return {
      fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
      lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
      letterSpacing: getComputedStyle(element).letterSpacing,
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      canvasWidth: element.querySelector(".bowtie-canvas-viewport")?.scrollWidth ?? 0,
      canvasViewportWidth: element.querySelector(".bowtie-canvas-viewport")?.clientWidth ?? 0,
      pathMembershipWrap: pathMembership ? getComputedStyle(pathMembership).overflowWrap : "missing",
    };
  });
  expect(reflow.fontSize).toBeGreaterThanOrEqual(13);
  expect(reflow.lineHeight / reflow.fontSize).toBeGreaterThanOrEqual(1.5);
  expect(["normal", "0px"]).toContain(reflow.letterSpacing);
  expect(reflow.pathMembershipWrap).toBe("normal");
  expect(reflow.scrollWidth).toBeLessThanOrEqual(reflow.viewportWidth);
  expect(reflow.canvasWidth).toBeLessThanOrEqual(reflow.canvasViewportWidth);

  await page.locator(".skip-link").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
  await page.getByRole("button", { name: "กลับไปแผนที่", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/map\?fl84Viewport=preserved$/);
});

test("an unknown Bowtie shows an empty state and returns to the same map URL state", async ({ page }) => {
  await page.evaluate(() => {
    window.history.pushState({}, "", "/bowtie/unknown?fl35Viewport=preserved");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });

  await expect(page.getByRole("heading", { name: "This Bowtie could not be loaded." })).toBeVisible();
  await expect(page.getByText("This Bowtie is not part of the available synthetic demo set.")).toBeVisible();
  await page.getByRole("button", { name: "Back to map" }).click();
  await expect(page).toHaveURL(/\/map\?fl35Viewport=preserved$/);
});
