import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function signInAs(page: import("@playwright/test").Page, role: "viewer" | "operator" = "operator") {
  await page.goto("/map");
  await expect(page.getByRole("heading", { name: "Scripted SSO" })).toBeVisible();
  await page.getByRole("link", { name: `Sign in as ${role}` }).click();
  await expect(page.getByRole("heading", { name: "Geo Command Map", exact: true })).toBeVisible();
}

test.beforeEach(async ({ request }) => { await request.get("/test/reset"); });

test("a Viewer can read Drafts without decision controls", async ({ page }) => {
  await signInAs(page, "viewer");
  await page.getByRole("link", { name: "Draft review" }).click();
  await expect(page.getByRole("heading", { name: "Management summary Drafts", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open source record /api/v1/bowties/00000000-0000-4000-8000-000000000111/risk" })).toBeVisible();
  await expect(page.getByText("An Operator or Manager can decide this Draft.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve Draft" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reject Draft" })).toHaveCount(0);
});

test("reviews a cited management summary and shows the server approval stamp", async ({ page, request }) => {
  await signInAs(page);
  await page.getByRole("link", { name: "Draft review" }).click();
  await expect(page.getByRole("heading", { name: "Management summary Drafts", exact: true })).toBeVisible();

  const sourceLink = page.locator(".draft-review-content a");
  await expect(sourceLink).toHaveText("4");
  await expect(sourceLink).toHaveAttribute("href", "/api/v1/bowties/00000000-0000-4000-8000-000000000111/risk");

  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(audit.violations).toEqual([]);
  }

  const approveRequest = page.waitForRequest((candidate) => candidate.method() === "POST" && candidate.url().endsWith(":approve"));
  const approveResponse = page.waitForResponse((candidate) => candidate.request().method() === "POST" && candidate.url().endsWith(":approve"));
  await page.getByRole("button", { name: "Approve Draft" }).click();
  const requestData = await approveRequest;
  expect(requestData.headers()["x-csrf-token"]).toBeTruthy();
  expect(requestData.headers()["idempotency-key"]).toMatch(/^[A-Za-z0-9._:-]{16,128}$/);
  expect((await approveResponse).status()).toBe(200);

  await expect(page.getByText(/^AI-assisted, approved by Synthetic operator, \d{4}-\d{2}-\d{2}$/)).toBeVisible();
  await expect(page.getByRole("tab", { name: "Approved" })).toHaveAttribute("aria-selected", "true");
  const state = await (await request.get("/test/draft-state")).json();
  expect(state.decisions).toEqual([{ draftId: "00000000-0000-4000-8000-000000000101", decision: "approve", reason: null, approver: "synthetic-operator" }]);
});
