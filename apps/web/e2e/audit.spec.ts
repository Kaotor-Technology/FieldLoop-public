import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.beforeEach(async ({ request }) => { await request.get("/test/reset"); });

async function signIn(page: Page, role: string) {
  await page.goto("/map");
  await expect(page.getByRole("heading", { name: "Scripted SSO" })).toBeVisible();
  await page.getByRole("link", { name: `Sign in as ${role}` }).click();
  await expect(page.getByRole("heading", { name: "Geo Command Map", exact: true })).toBeVisible();
}

test("an operator reads, filters and pages the audit log through the BFF", async ({ page }) => {
  await signIn(page, "operator");
  const requests: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/v1/audit") requests.push(request.url()); });
  await page.getByRole("link", { name: "Audit", exact: true }).click();
  await expect(page).toHaveURL(/\/audit$/);
  await expect(page.getByRole("heading", { name: "Audit log", level: 1 })).toBeVisible();
  const table = page.getByRole("table", { name: "Audit events, newest first" });
  await expect(table.getByRole("row")).toHaveCount(4);
  await expect(table.getByRole("row").nth(1)).toContainText("barrier.health_changed");
  await expect(table.getByRole("row").nth(1)).toContainText("2026-10-14 00:03:00.000003 UTC");
  await expect(table.getByText("SIMULATION").first()).toBeVisible();

  await page.getByLabel("Entity type").fill("health_proposal");
  await page.getByRole("button", { name: "Apply filter" }).click();
  await expect(page).toHaveURL(/\/audit\?entityType=health_proposal$/);
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table).toContainText("health_proposal.accepted");
  expect(requests.at(-1)).toContain("entityType=health_proposal");

  await page.getByLabel("Entity type").fill("Not Valid");
  await page.getByRole("button", { name: "Apply filter" }).click();
  await expect(page.getByText("Use lowercase letters, digits and underscores")).toBeVisible();
  await page.getByRole("button", { name: "Clear filter" }).click();
  await expect(table.getByRole("row")).toHaveCount(4);

  await table.getByText("Show hashes").first().click();
  await expect(table.getByText("Event hash").first()).toBeVisible();
  await expect(table.getByText("a".repeat(64)).first()).toBeVisible();
});

test("the audit log has no axe violations in light and night shift themes", async ({ page }) => {
  await signIn(page, "operator");
  await page.goto("/audit");
  await expect(page.getByRole("table", { name: "Audit events, newest first" })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Night shift" }).click();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("a viewer sees no Audit link and is told the log is unavailable", async ({ page }) => {
  await signIn(page, "viewer");
  await expect(page.getByRole("link", { name: "Audit", exact: true })).toHaveCount(0);
  const apiCalls: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/v1/audit") apiCalls.push(request.url()); });
  await page.goto("/audit");
  await expect(page.getByRole("alert")).toContainText("operators and managers only");
  expect(apiCalls).toEqual([]);
});
