import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.beforeEach(async ({ request }) => { await request.get("/test/reset"); });

async function signInAsOperator(page: Page) {
  await page.goto("/map");
  await expect(page.getByRole("heading", { name: "Scripted SSO" })).toBeVisible();
  await page.getByRole("link", { name: "Sign in as operator" }).click();
  await expect(page.getByRole("heading", { name: "Geo Command Map", exact: true })).toBeVisible();
}

function commandPackageFixture(id: string, target: string) {
  return {
    id,
    actionRequestId: "00000000-0000-4000-8000-000000000711",
    target,
    action: "Inspect synthetic equipment",
    rationale: "Confirm simulated readiness",
    citations: ["synthetic:procedure-7"],
    procedure: "PROC-SYN-7",
    preconditions: ["Equipment is isolated from live systems"],
    barrierId: "00000000-0000-4000-8000-000000000183",
    expectedEffect: "Confirm simulated equipment readiness.",
    approvalCount: 2,
    actionStatus: "approved",
    executionStatus: "queued",
    outcome: null,
    evidenceId: null,
    recordedBy: null,
    recordedAt: null,
    simulated: true,
    classification: "INTERNAL",
    createdAt: "2026-10-15T00:00:00.000Z",
    expiresAt: "2026-10-15T01:00:00.000Z",
  };
}

test("Command Package queue shows required details and locks outcomes before two approvals", async ({ page }) => {
  await signInAsOperator(page);
  await page.getByRole("link", { name: "Command Packages", exact: true }).click();
  await expect(page).toHaveURL(/\/command-packages$/);
  await expect(page.getByRole("heading", { name: "Command Package queue", level: 1 })).toBeVisible();
  const pending = page.locator(".command-package-card").filter({ hasText: "SYNTHETIC-PUMP-3" });
  await expect(pending).toContainText("Deploy mobile pump");
  await expect(pending).toContainText("Reduce simulated flood exposure");
  await expect(pending).toContainText("PROC-SYN-7");
  await expect(pending).toContainText("Reduce standing water at the synthetic hospital access route.");
  await expect(pending).toContainText("Pump isolated from live grid");
  await expect(pending.getByText("SIMULATION", { exact: true })).toBeVisible();
  await expect(pending.getByRole("textbox", { name: "Outcome and reason" })).toBeDisabled();
  await expect(pending.getByRole("status")).toContainText("1 of 2");
  const approved = page.locator(".command-package-card").filter({ hasText: "SYNTHETIC-GATE-2" });
  await expect(approved.getByRole("textbox", { name: "Outcome and reason" })).toBeEnabled();
});

test("queue loads the next page using the returned cursor", async ({ page }) => {
  await signInAsOperator(page);
  const cursors: (string | null)[] = [];
  await page.route("**/api/v1/command-packages*", async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    cursors.push(cursor);
    const items = cursor === "second-page"
      ? [commandPackageFixture("00000000-0000-4000-8000-000000000722", "SYNTHETIC-GATE-SECOND-PAGE")]
      : [commandPackageFixture("00000000-0000-4000-8000-000000000721", "SYNTHETIC-PUMP-FIRST-PAGE")];
    await route.fulfill({ status: 200, json: { items, limit: 50, nextCursor: cursor ? null : "second-page" } });
  });

  await page.goto("/command-packages");
  await expect(page.getByText("SYNTHETIC-PUMP-FIRST-PAGE", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load more Command Packages" }).click();
  await expect(page.getByText("SYNTHETIC-GATE-SECOND-PAGE", { exact: true })).toBeVisible();
  expect(cursors).toEqual([null, "second-page"]);
});

test("queue status filters are restored from and written to the URL", async ({ page }) => {
  await signInAsOperator(page);
  await page.goto("/command-packages?status=executed");
  const navigation = page.getByRole("navigation", { name: "Filter Command Packages" });
  await expect(navigation.getByRole("button", { name: "Executed", exact: true })).toHaveAttribute("aria-pressed", "true");
  await navigation.getByRole("button", { name: "Not executed", exact: true }).click();
  await expect(page).toHaveURL(/\/command-packages\?status=not_executed$/);
  await expect(navigation.getByRole("button", { name: "Not executed", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("operator records executed or not executed and the result becomes Evidence", async ({ page }) => {
  await signInAsOperator(page);
  const queueResponse = page.waitForResponse((response) => response.request().method() === "GET" && response.url().includes("/api/v1/command-packages"));
  await page.goto("/command-packages");
  const queue = await queueResponse;
  const queuePage = await queue.json() as { items: Array<{ target: string }> };
  expect(queuePage.items.map((item) => item.target)).toContain("SYNTHETIC-GATE-2");
  const approved = page.locator(".command-package-card").filter({ hasText: "SYNTHETIC-GATE-2" });
  const outcome = approved.getByRole("textbox", { name: "Outcome and reason" });
  await outcome.fill("Gate inspected; operator confirmed simulated position.");
  await approved.getByLabel("Not executed").check();
  const responsePromise = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/api/v1/command-packages/") && response.url().endsWith("/outcome"));
  await approved.getByRole("button", { name: "Record outcome", exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  expect(response.request().headers()["x-csrf-token"]).toBeTruthy();
  expect(response.request().headers()["idempotency-key"]).toMatch(/^[A-Za-z0-9._:-]{16,128}$/);
  const notExecutedTab = page.getByRole("navigation", { name: "Filter Command Packages" }).getByRole("button", { name: "Not executed", exact: true });
  await notExecutedTab.focus();
  await page.keyboard.press("Enter");
  const recorded = page.locator(".command-package-card").filter({ hasText: "SYNTHETIC-GATE-2" });
  await expect(recorded.getByRole("heading", { name: "Recorded outcome" })).toBeVisible();
  await expect(recorded).toContainText("Gate inspected; operator confirmed simulated position.");
  await expect(recorded).toContainText("Evidence ID");
});

test("Command Package queue has no axe violations in both themes and reflows in Thai", async ({ page }) => {
  await signInAsOperator(page);
  await page.goto("/command-packages");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      expect(audit.violations, `${colorScheme}/${width}: ${JSON.stringify(audit.violations)}`).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${colorScheme}/${width}: horizontal overflow`).toBe(true);
    }
  }
  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByRole("button", { name: "ภาษาไทย", exact: true }).click();
  await expect(page.getByRole("heading", { name: "คิวชุดคำสั่ง", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("queue tabs and outcome form can be operated with the keyboard", async ({ page }) => {
  await signInAsOperator(page);
  await page.goto("/command-packages");
  const queuedTab = page.getByRole("button", { name: "Queue", exact: true });
  await queuedTab.focus();
  await expect(queuedTab).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Executed", exact: true })).toBeFocused();
  const approved = page.locator(".command-package-card").filter({ hasText: "SYNTHETIC-GATE-2" });
  await approved.getByLabel("Executed", { exact: true }).focus();
  await page.keyboard.press("Space");
  await expect(approved.getByLabel("Executed", { exact: true })).toBeChecked();
  const result = approved.getByRole("textbox", { name: "Outcome and reason" });
  await result.focus();
  await result.fill("Recorded with keyboard.");
  const submit = approved.getByRole("button", { name: "Record outcome", exact: true });
  await submit.focus();
  await expect.poll(() => submit.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
  const saved = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/outcome"));
  await page.keyboard.press("Enter");
  expect((await saved).status()).toBe(200);
  const executedTab = page.getByRole("button", { name: "Executed", exact: true });
  await executedTab.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".command-package-card").filter({ hasText: "SYNTHETIC-GATE-2" })).toContainText("Recorded outcome");
});

test("viewer cannot see or use the Command Package queue", async ({ page }) => {
  await page.goto("/map");
  await page.getByRole("link", { name: "Sign in as viewer" }).click();
  await expect(page.getByRole("heading", { name: "Geo Command Map", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Command Packages", exact: true })).toHaveCount(0);
  const calls: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/v1/command-packages") calls.push(request.url()); });
  await page.goto("/command-packages");
  await expect(page.getByRole("alert")).toContainText("control-room operators");
  expect(calls).toEqual([]);
});
