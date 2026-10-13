import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.beforeEach(async ({ request, page }) => {
  await request.get("/test/reset");
  await page.goto("/map");
  await page.getByRole("link", { name: "Sign in as operator" }).click();
  await expect(page.getByRole("heading", { name: "Scenario player" })).toBeVisible();
});
async function createRun(page: import("@playwright/test").Page) {
  await page.getByLabel("Scenario", { exact: true }).click();
  await page.getByRole("option", { name: "Player verification fixture", exact: true }).click();
  await page.getByRole("button", { name: "Create run", exact: true }).click();
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
}
test("controls mirror the server and reset changes identity and clears bookmark selection", async ({ page }) => {
  await createRun(page);
  await page.getByRole("button", { name: "Step", exact: true }).click();
  await page.getByLabel("Bookmark", { exact: true }).click();
  await page.getByRole("option", { name: "Failure", exact: true }).click();
  await page.getByRole("button", { name: "Jump to bookmark", exact: true }).click();
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "60");
  await page.getByRole("button", { name: "Reset simulation", exact: true }).click();
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "0");
  await expect(page.getByLabel("Bookmark", { exact: true })).toContainText("Choose a bookmark");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByRole("button", { name: "Step", exact: true })).toBeEnabled();
  await page.getByLabel("Speed", { exact: true }).click();
  await page.getByRole("option", { name: "60×", exact: true }).click();
  await expect(page.locator(".workspace-banner")).toContainText("60×");
});
test("jumping to an earlier bookmark starts a clean replay epoch", async ({ page }) => {
  await createRun(page);
  await page.getByLabel("Bookmark", { exact: true }).click();
  await page.getByRole("option", { name: "Failure", exact: true }).click();
  await page.getByRole("button", { name: "Jump to bookmark", exact: true }).click();
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "60");
  const previous = await page.evaluate(async () => (await fetch("/api/v1/simulation/runs/current")).json());
  await page.getByLabel("Bookmark", { exact: true }).click();
  await expect(page.getByRole("option", { name: "Start", exact: true })).toBeEnabled();
  await page.getByRole("option", { name: "Start", exact: true }).click();
  const responsePromise = page.waitForResponse((response) => response.url().includes(":bookmark") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Jump to bookmark", exact: true }).click();
  const rewound = await (await responsePromise).json();
  expect(rewound.id).not.toBe(previous.id);
  expect(rewound.elapsedSeconds).toBe(0);
  expect(rewound.nextEventIndex).toBe(1);
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "0");
});
test("failed commands retain confirmed state and show an error", async ({ page }) => {
  await createRun(page);
  await page.route("**/api/v1/simulation/runs/*:step", (route) => route.fulfill({ status: 503, contentType: "application/problem+json", body: JSON.stringify({ type: "about:blank", status: 503, title: "Fixture unavailable" }) }));
  await page.getByRole("button", { name: "Step", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Simulation could not be updated");
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "0");
});
for (const theme of ["light", "dark"]) for (const width of [390, 1280]) {
  test(`simulation accessibility ${theme} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    if (theme === "dark") await page.getByRole("button", { name: "Night shift" }).click();
    await createRun(page);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "Play", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Pause", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Step", exact: true })).toBeEnabled();
    if (theme === "light" && width === 1280) await page.screenshot({ path: "e2e/evidence/simulation-player.png", fullPage: true });
  });
}
test("Thai controls reflow at 320 px without horizontal scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await createRun(page);
  await page.getByRole("button", { name: "ภาษาไทย", exact: true }).click();
  await expect(page.getByRole("button", { name: "เล่น", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: "e2e/evidence/simulation-player-thai-320.png", fullPage: true });
});

test("timeline fields and commands are reachable in keyboard order", async ({ page }) => {
  await createRun(page);
  await page.getByRole("button", { name: "Play", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Step", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".simulation-status")).toContainText("Paused");
  await expect(page.getByRole("button", { name: "Step", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Step", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Speed", { exact: true })).toBeFocused();
  await page.keyboard.press("Space");
  await expect(page.getByRole("option", { name: "1×", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: "10×", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".workspace-banner")).toContainText("10×");
  await expect(page.getByLabel("Speed", { exact: true })).toBeEnabled();
  await page.getByLabel("Speed", { exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Bookmark", { exact: true })).toBeFocused();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: "Failure", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Bookmark", { exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Jump to bookmark", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "60");
  await expect(page.getByRole("button", { name: "Reset simulation", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Jump to bookmark", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Reset simulation", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("progressbar")).toHaveAttribute("value", "0");
});

test("a Viewer sees the live simulation without control buttons", async ({ page, browser }) => {
  await createRun(page);
  const viewer = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const viewerPage = await viewer.newPage();
    await viewerPage.goto("/map");
    await viewerPage.getByRole("link", { name: "Sign in as viewer" }).click();
    await expect(viewerPage.getByRole("progressbar")).toBeVisible();
    await expect(viewerPage.getByRole("button", { name: "Play", exact: true })).toHaveCount(0);
    await expect(viewerPage.getByRole("button", { name: "Reset simulation", exact: true })).toHaveCount(0);
  } finally { await viewer.close(); }
});
