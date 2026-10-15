import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";

test.beforeEach(async ({ page }) => { await page.coverage.startJSCoverage(); });
test.afterEach(async ({ page }, info) => {
  const coverage = (await page.coverage.stopJSCoverage()).filter(entry => entry.url.includes("/src/StripBand.tsx"));
  const directory = process.env["FL93_EVIDENCE_DIR"] ?? "test-results/strip-band";
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `coverage-${info.title.replace(/[^a-z0-9-]/gi, "-")}.json`), JSON.stringify(coverage));
});

for (const theme of ["light", "dark"] as const) for (const width of [320, 390, 1280]) for (const language of ["en", "th"] as const) {
  test(`static strip ${theme} ${width} ${language}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/strip-band-fixture.html?theme=${theme}&language=${language}`);
    await expect(page.getByText("SIMULATION · SYNTHETIC", { exact: true })).toBeVisible();
    const band = page.locator(".strip-band");
    await expect(band).toHaveAttribute("lang", language);
    await expect(band.getByRole("button")).toHaveCount(0);
    await expect(band.getByRole("link")).toHaveCount(0);
    await expect(band.locator("input, select, textarea")).toHaveCount(0);
    await expect(page.getByText("SYNTHETIC-FIXTURE", { exact: true })).toBeVisible();
    const unverified = band.locator('.fl-health-badge[data-health="unverified"]');
    await expect(unverified).toBeVisible();
    await expect(unverified).toHaveText(`⬚${language === "th" ? "ยังไม่ยืนยัน" : "Unverified"}`);
    const healthCues = await band.locator(".strip-barriers li > span:nth-child(2)").evaluateAll(elements => elements.map(element => ({
      shape: element.firstElementChild?.textContent,
      background: getComputedStyle(element).backgroundColor,
      colour: getComputedStyle(element).color,
    })));
    expect(healthCues.map(cue => cue.shape)).toEqual(["●", "▲", "✖", "⬚"]);
    expect(new Set(healthCues.map(cue => `${cue.colour}/${cue.background}`)).size).toBe(4);
    for (const cue of healthCues) expect(cue.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await band.locator(".strip-mono").first().evaluate(element => getComputedStyle(element).fontFamily)).toContain("IBM Plex Mono");
    const typography = await band.evaluate(element => { const s = getComputedStyle(element); return { size: parseFloat(s.fontSize), line: parseFloat(s.lineHeight), spacing: s.letterSpacing }; });
    expect(typography.line / typography.size).toBeGreaterThanOrEqual(1.5);
    expect(typography.spacing).toBe("normal");
    // The display introduces no focus targets or traps. The fixture's skip link remains usable.
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to static strip" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("main")).toBeFocused();
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(result.violations).toEqual([]);
    const geometry = await band.locator(".strip-segments").evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return { width: bounds.width, parts: Array.from(element.children, child => {
        const part = child.getBoundingClientRect();
        return { left: part.left - bounds.left, width: part.width, top: part.top - bounds.top };
      }) };
    });
    expect(geometry.parts).toHaveLength(2);
    const [short, long] = geometry.parts;
    if (!short || !long) throw new Error("Missing fixture Segments");
    expect(short.left).toBeCloseTo(0, 0);
    expect(short.width).toBeCloseTo(geometry.width * 0.25, 0);
    expect(long.left).toBeCloseTo(geometry.width * 0.25, 0);
    expect(long.width).toBeCloseTo(geometry.width * 0.75, 0);
    expect(long.top).toBeCloseTo(short.top, 0);
    await page.screenshot({ path: `${process.env["FL93_EVIDENCE_DIR"] ?? "test-results"}/strip-${theme}-${width}-${language}.png`, fullPage: true });
  });
}

test("fixture server never serves the classified generated seed", async ({ request }) => {
  for (const filename of ["strip-band.json", "route.geojson", "segments.geojson", "facilities.geojson", "bowtie-a.json", "generate.mjs", "strip-band.mjs"]) {
    const response = await request.get(`/@fs/${process.cwd()}/../../data/synthetic/dl-01/${filename}`);
    expect(response.status()).toBe(403);
    const body = await response.text();
    expect(body).not.toContain('"chainageFromM"');
    expect(body).not.toContain('"barriers"');
    expect(body).not.toContain('"coordinates"');
  }
});

test("Barrier names and state cues remain visually separated", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/strip-band-fixture.html");
  const gaps = await page.locator(".strip-barriers li").evaluateAll(items => items.map(item => {
    const [name, state] = item.children;
    if (!name || !state) throw new Error("Missing Barrier name or state cue");
    return state.getBoundingClientRect().left - name.getBoundingClientRect().right;
  }));
  expect(gaps).toHaveLength(4);
  for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(4);
});
