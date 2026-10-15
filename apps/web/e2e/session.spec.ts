import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.beforeEach(async ({ request }) => { await request.get("/test/reset"); });

async function signIn(page: Page, role = "operator", path = "/map") {
  await page.goto(path);
  await expect(page.getByRole("heading", { name: "Scripted SSO" })).toBeVisible();
  await page.getByRole("link", { name: `Sign in as ${role}` }).click();
  await expect(page.getByRole("heading", { name: "Geo Command Map", exact: true })).toBeVisible();
}

test("SSO returns to the deep link and only an opaque HttpOnly cookie reaches browser storage", async ({ page, context }) => {
  const meResponses: unknown[] = [];
  page.on("response", async (response) => { if (response.url().endsWith("/api/v1/me") && response.ok()) meResponses.push(await response.json()); });
  await signIn(page, "operator", "/map?selected=synthetic-asset#barriers");
  await expect(page).toHaveURL(/\/map\?selected=synthetic-asset#barriers$/);
  const cookies = await context.cookies();
  expect(cookies).toHaveLength(1);
  expect(cookies[0]).toMatchObject({ name: "fl_session", httpOnly: true, secure: true, sameSite: "Lax" });
  expect(cookies[0]?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const storage = await page.evaluate(async () => ({ cookie: document.cookie, local: { ...localStorage }, session: { ...sessionStorage }, databases: await indexedDB.databases() }));
  expect(storage).toEqual({ cookie: "", local: {}, session: {}, databases: [] });
  expect(meResponses).toContainEqual(expect.objectContaining({ sub: "synthetic-operator", roles: ["fieldloop.operator"], persona: "Integrity Engineer", csrfToken: expect.any(String), authTime: expect.any(String) }));
  expect(JSON.stringify(meResponses)).not.toMatch(/server-only-(access|refresh|id)-token/);
});

test("account switching sends CSRF, deletes the old session and obtains server-derived roles", async ({ page, request }) => {
  await signIn(page, "viewer");
  await page.locator(".account-switcher > summary").click();
  const logoutRequest = page.waitForRequest((req) => req.url().endsWith("/api/auth/logout"));
  await page.getByRole("button", { name: "Sign out and change account" }).click();
  expect((await logoutRequest).headers()["x-csrf-token"]).toBeTruthy();
  await expect(page.getByRole("heading", { name: "Confirm SSO logout" })).toBeVisible();
  expect(await (await request.get("/test/status")).json()).toEqual({ sessions: 0 });
  await page.getByRole("link", { name: "Confirm logout" }).click();
  await page.getByRole("link", { name: "Sign in as manager" }).click();
  await page.locator(".account-switcher > summary").click();
  await expect(page.getByText("fieldloop.manager", { exact: true })).toBeVisible();
  await expect(page.getByText("synthetic-viewer", { exact: true })).toHaveCount(0);
});

test("the Geo Command Map Overview renders scoped summaries and unavailable Action Request data", async ({ page }) => {
  await signIn(page);
  const panel = page.getByRole("complementary", { name: "Map context panel" });
  await expect(panel.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Risk summary", exact: true })).toBeVisible();
  await expect(panel.locator(".risk-summary-row strong")).toHaveText(["0", "0", "0"]);
  await expect(panel.getByRole("heading", { name: "Barriers by Health", exact: true })).toBeVisible();
  await expect(panel.locator(".barrier-summary-row strong")).toHaveText(["0", "0", "0", "0"]);
  await expect(panel.getByRole("heading", { name: "Open Action Requests", exact: true })).toBeVisible();
  await expect(panel.getByText("Action Request data is not available in the current map view.", { exact: true })).toBeVisible();
});

test("missing CSRF gets 403 without deleting the active session", async ({ page }) => {
  await signIn(page);
  const result = await page.request.post("/api/auth/logout");
  expect(result.status()).toBe(403);
  expect((await result.json()).code).toBe("csrf_token_invalid");
  expect((await page.request.get("/api/v1/me")).status()).toBe(200);
});

test("inactive introspection deletes the session and hides cached identity on the next validation", async ({ page, request }) => {
  await page.clock.install();
  await signIn(page);
  await request.get("/test/revoke");
  await page.clock.fastForward(60_000);
  await expect(page.getByRole("heading", { name: "Scripted SSO" })).toBeVisible();
  expect(await (await request.get("/test/status")).json()).toEqual({ sessions: 0 });
});

test("back-channel logout by sid makes the next API call unauthenticated", async ({ page, request }) => {
  await page.clock.install();
  await signIn(page);
  const logout = await request.post("/api/auth/backchannel-logout", { form: { logout_token: "fixture-signed:synthetic-sid-operator" } });
  expect(logout.status()).toBe(204);
  expect((await page.request.get("/api/v1/me")).status()).toBe(401);
  // Revalidate through the app so a second navigation cannot race its SSO redirect.
  await page.clock.fastForward(60_000);
  await expect(page.getByRole("heading", { name: "Scripted SSO" })).toBeVisible();
  expect(await (await request.get("/test/status")).json()).toEqual({ sessions: 0 });
});

test("an unavailable IdP shows a retry state, then recovers without a login loop", async ({ page, request }) => {
  await signIn(page);
  await request.get("/test/unavailable?enabled=true");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign-in is temporarily unavailable" })).toBeVisible();
  await expect(page.getByText("synthetic-operator", { exact: true })).toHaveCount(0);
  await request.get("/test/unavailable?enabled=false");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Geo Command Map", exact: true })).toBeVisible();
});

for (const width of [390, 1024, 1280]) for (const colorScheme of ["light", "dark"] as const) {
  test(`map entry and switcher accessibility: ${colorScheme}, ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await signIn(page);
    await page.locator(".account-switcher > summary").click();
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "ภาษาไทย" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "th");
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 320, height: 900 });
    const overflow = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      viewport: innerWidth,
      elements: [...document.querySelectorAll("body *")]
        .map((element) => ({ name: element.tagName.toLowerCase(), className: typeof element.className === "string" ? element.className : "", right: Math.ceil(element.getBoundingClientRect().right) }))
        .filter((element) => element.right > innerWidth)
        .slice(0, 8),
    }));
    expect(overflow.width, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.viewport);
    if (width === 1280 && colorScheme === "light") {
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole("button", { name: "English" }).click();
      await page.locator(".account-switcher > summary").click();
      await page.screenshot({ path: "test-results/map-entry.png", fullPage: true });
    }
  });
}

test("all account and preference controls work by keyboard with visible focus", async ({ page }) => {
  await signIn(page);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "FieldLoop-v2" })).toBeFocused();
  // Operators and managers also get the Audit link before the account controls.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Audit", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator(".account-switcher > summary")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Ask agent" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "ภาษาไทย" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("lang", "th");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "โหมดกะกลางคืน" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("link", { name: "Ask agent" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator(".account-switcher > summary")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Map" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Layers" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".layer-control > summary")).toBeFocused();
  expect(await page.locator(".layer-control > summary").evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
  await page.keyboard.press("Enter");
  await expect(page.locator(".layer-control")).not.toHaveAttribute("open", "");
  await page.keyboard.press("Enter");
  await expect(page.locator(".layer-control")).toHaveAttribute("open", "");
  await page.keyboard.press("Tab");
  await expect(page.locator(".layer-control input[type=checkbox]").first()).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("checkbox", { name: "Geo References" })).toBeFocused();
  await page.keyboard.press("Tab");
  const rainToggle = page.getByRole("checkbox", { name: "Scenario rain (SIMULATION)" });
  await expect(rainToggle).toBeFocused();
  await page.keyboard.press("Space");
  await expect(rainToggle).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(rainToggle).toBeChecked();
});
