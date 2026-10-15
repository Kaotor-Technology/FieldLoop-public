import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.beforeEach(async ({ page }) => { await page.goto("/ui-preview.html"); });

for (const theme of ["light", "dark"] as const) {
  for (const width of [390, 1280]) {
    test(`Health Proposal review has no axe violations in ${theme} at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await expect(page.getByRole("heading", { name: "Health Proposals", exact: true })).toBeVisible();
      const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      expect(audit.violations).toEqual([]);
    });
  }
}

test("accept and reject submit a reason while the displayed Health remains server-owned", async ({ page }) => {
  const acceptRow = page.locator(".health-proposal-row").filter({ hasText: "SYNTHETIC-B-001" });
  await acceptRow.getByRole("button", { name: "Accept Health Proposal for Rectifier output" }).click();
  const acceptReason = acceptRow.getByRole("textbox", { name: "Decision reason" });
  await expect(acceptRow.getByRole("button", { name: "Accept", exact: true })).toBeDisabled();
  await acceptReason.fill("Synthetic owner review accepted");
  await acceptRow.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(acceptRow.getByRole("status")).toContainText("Decision saved");
  const healthChange = acceptRow.getByRole("group", { name: "Proposed Barrier Health change" });
  await expect(healthChange).toContainText("Healthy");
  await expect(healthChange).toContainText("Degraded");
  await expect(page.getByRole("status", { name: "Last Health Proposal decision" })).toHaveText("synthetic-proposal-001|accept|Synthetic owner review accepted");

  const rejectRow = page.locator(".health-proposal-row").filter({ hasText: "SYNTHETIC-B-002" });
  await rejectRow.getByRole("button", { name: "Reject Health Proposal for SYNTHETIC-B-002" }).click();
  await rejectRow.getByRole("textbox", { name: "Decision reason" }).fill("Synthetic review rejected");
  await rejectRow.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(page.getByRole("status", { name: "Last Health Proposal decision" })).toHaveText("synthetic-proposal-002|reject|Synthetic review rejected");
});

test("the reason form is keyboard operable and labels its required field", async ({ page }) => {
  const row = page.locator(".health-proposal-row").filter({ hasText: "SYNTHETIC-B-001" });
  const accept = row.getByRole("button", { name: "Accept Health Proposal for Rectifier output" });
  await accept.focus();
  await page.keyboard.press("Enter");
  const reason = row.getByRole("textbox", { name: "Decision reason" });
  await expect(reason).toBeFocused();
  await expect(reason).toHaveAttribute("required", "");
  await reason.fill("Keyboard submitted reason");
  await page.keyboard.press("Tab");
  await expect(row.getByRole("button", { name: "Accept", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status", { name: "Last Health Proposal decision" })).toContainText("accept|Keyboard submitted reason");
});
