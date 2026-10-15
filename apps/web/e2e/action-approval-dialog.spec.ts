import { expect, test, type Page, type Request } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const approvals = "**/api/v1/action-requests/96000000-0000-4000-8000-000000000001/approvals";
const reject = "**/api/v1/action-requests/96000000-0000-4000-8000-000000000001:reject";
const decided = (decision: "approved" | "rejected") => ({
  actionRequest: { id: "96000000-0000-4000-8000-000000000001", status: decision },
  approval: { id: "96000000-0000-4000-8000-0000000000a1", decision },
});

test.beforeEach(async ({ page }) => { await page.goto("/ui-preview.html"); });

const openDialog = async (page: Page, name = "Open approval dialog") => {
  await page.getByRole("button", { name, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
};

for (const theme of ["light", "dark"] as const) {
  for (const width of [390, 1280]) {
    test(`approval dialog has no axe violations in ${theme} at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await openDialog(page);
      const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      expect(audit.violations).toEqual([]);
    });
  }
}

test("says what will happen, shows the exact payload in mono and labels the second-approver step as a mock", async ({ page }) => {
  const dialog = await openDialog(page);
  await expect(dialog.getByRole("heading", { name: "Approve sending the simulated warning to the sandbox inbox" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "This does", exact: true })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "This does not", exact: true })).toBeVisible();
  await expect(dialog.getByText("SIMULATION", { exact: true }).first()).toBeVisible();
  const payload = dialog.locator("pre.approval-payload");
  await expect(payload).toContainText('"channel": "sandbox-inbox"');
  expect(await payload.evaluate((node) => getComputedStyle(node).fontFamily)).toMatch(/mono/i);
  await expect(dialog.getByText("a".repeat(64))).toBeVisible();
  await expect(dialog.getByRole("heading", { name: /Second approval required — Phase 1/ })).toBeVisible();
  await expect(dialog.getByText("MOCK", { exact: true })).toBeVisible();
});

test("never starts on Approve, ignores the scrim, closes with Escape and returns focus to the trigger", async ({ page }) => {
  const trigger = page.getByRole("button", { name: "Open approval dialog", exact: true });
  const dialog = await openDialog(page);
  await expect(dialog.getByRole("button", { name: "Approve", exact: true })).not.toBeFocused();
  await expect(dialog.getByRole("heading", { level: 2 })).toBeFocused();
  await page.mouse.click(5, 5);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("both decisions need a reason, and Enter never approves while Space does, sending the exact hash with CSRF and an Idempotency-Key", async ({ page }) => {
  const seen: Request[] = [];
  await page.route(approvals, async (route) => { seen.push(route.request()); await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(decided("approved")) }); });
  const dialog = await openDialog(page);
  const approve = dialog.getByRole("button", { name: "Approve", exact: true });
  await expect(approve).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Reject", exact: true })).toBeDisabled();
  await dialog.getByRole("textbox", { name: "Reason for your decision" }).fill("Reviewed the exact payload");
  await approve.focus();
  await page.keyboard.press("Enter");
  expect(seen).toHaveLength(0);
  await page.keyboard.press("Space");
  await expect(dialog.getByRole("status").filter({ hasText: "Approval recorded" })).toBeVisible();
  expect(seen).toHaveLength(1);
  expect(seen[0]?.postDataJSON()).toEqual({ payloadHash: "a".repeat(64), reason: "Reviewed the exact payload" });
  expect(seen[0]?.headers()["x-csrf-token"]).toBe("synthetic-csrf");
  expect(seen[0]?.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
});

test("reject records a reason through the reject command", async ({ page }) => {
  let body: unknown;
  await page.route(reject, async (route) => { body = route.request().postDataJSON(); await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(decided("rejected")) }); });
  const dialog = await openDialog(page);
  await dialog.getByRole("textbox", { name: "Reason for your decision" }).fill("Not needed for the drill");
  await dialog.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "Rejection recorded" })).toBeVisible();
  expect(body).toEqual({ payloadHash: "a".repeat(64), reason: "Not needed for the drill" });
});

test("an old login offers a forced re-login that returns to the request, not a decision", async ({ page }) => {
  await page.route("**/api/auth/reauth**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>reauth</title>" }));
  const dialog = await openDialog(page, "Open approval dialog (old login)");
  await expect(dialog.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("status").filter({ hasText: "sign in again" })).toBeVisible();
  await dialog.getByRole("button", { name: "Sign in again to decide" }).click();
  await page.waitForURL(/\/api\/auth\/reauth\?return=%2Factions%2Fsynthetic%3Freview%3D1/);
});

test("the requester cannot decide their own request and nothing is sent", async ({ page }) => {
  let calls = 0;
  await page.route(/action-requests/, async (route) => { calls += 1; await route.abort(); });
  const dialog = await openDialog(page, "Open approval dialog (own request)");
  await expect(dialog.getByText("Another person must decide it.")).toBeVisible();
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /Approve|Reject/ })).toHaveCount(0);
  expect(calls).toBe(0);
});

test("a changed payload is reported as an alert, offers a reload and shows no success", async ({ page }) => {
  await page.route(approvals, (route) => route.fulfill({ status: 409, contentType: "application/problem+json", body: JSON.stringify({ type: "about:blank", title: "x", status: 409, code: "payload_changed" }) }));
  const dialog = await openDialog(page);
  await dialog.getByRole("textbox", { name: "Reason for your decision" }).fill("Reviewed");
  await dialog.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("The payload changed after you opened it");
  await expect(dialog.getByRole("button", { name: "Reload request" })).toBeVisible();
  await expect(dialog.getByText("Approval recorded")).toHaveCount(0);
});
