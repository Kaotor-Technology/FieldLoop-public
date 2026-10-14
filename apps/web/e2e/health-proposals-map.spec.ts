import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => { await request.get("/test/reset"); });

test("D15 reviews owner Health Proposals in the Overview panel through the BFF and SSE", async ({ page }) => {
  await page.goto("/map");
  await expect(page.getByRole("heading", { name: "Scripted SSO" })).toBeVisible();
  await page.getByRole("link", { name: "Sign in as operator" }).click();
  await expect(page.getByRole("heading", { name: "Geo Command Map", exact: true })).toBeVisible();

  const panel = page.getByRole("complementary", { name: "Map context panel" });
  await expect(panel.getByRole("heading", { name: "Health Proposals", exact: true })).toBeVisible();
  const acceptedRow = panel.locator(".health-proposal-row").filter({ hasText: "SYNTHETIC-CP-01" });
  await expect(acceptedRow).toContainText("SIMULATION");
  await expect(acceptedRow.getByRole("group", { name: "Proposed Barrier Health change" })).toContainText("Healthy");
  await expect(acceptedRow.getByRole("group", { name: "Proposed Barrier Health change" })).toContainText("Degraded");
  const acceptButton = acceptedRow.getByRole("button", { name: "Accept Health Proposal for SYNTHETIC-CP-01" });
  await acceptButton.focus();
  await page.keyboard.press("Enter");
  const acceptReason = acceptedRow.getByRole("textbox", { name: "Decision reason" });
  await expect(acceptReason).toBeFocused();
  await acceptReason.fill("Synthetic owner inspection confirms degraded health.");
  await page.keyboard.press("Tab");
  await expect(acceptedRow.getByRole("button", { name: "Accept", exact: true })).toBeFocused();
  const acceptRequest = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith("/00000000-0000-4000-8000-000000000083:accept"));
  await page.keyboard.press("Enter");
  const accept = await acceptRequest;
  expect(accept.headers()["x-csrf-token"]).toBeTruthy();
  expect(accept.headers()["idempotency-key"]).toMatch(/^[A-Za-z0-9._:-]{16,128}$/);
  expect(accept.postDataJSON()).toEqual({ reason: "Synthetic owner inspection confirms degraded health." });
  await expect(acceptedRow).toHaveCount(0);
  await expect.poll(async () => (await (await page.request.get("/test/health-state")).json()).eventCount).toBe(1);

  const rejectedRow = panel.locator(".health-proposal-row").filter({ hasText: "SYNTHETIC-CP-02" });
  await rejectedRow.getByRole("button", { name: "Reject Health Proposal for SYNTHETIC-CP-02" }).click();
  await rejectedRow.getByRole("textbox", { name: "Decision reason" }).fill("Synthetic owner requests fresh inspection evidence.");
  const rejectRequest = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith("/00000000-0000-4000-8000-000000000084:reject"));
  await rejectedRow.getByRole("button", { name: "Reject", exact: true }).click();
  const reject = await rejectRequest;
  expect(reject.headers()["x-csrf-token"]).toBeTruthy();
  expect(reject.headers()["idempotency-key"]).toMatch(/^[A-Za-z0-9._:-]{16,128}$/);
  expect(reject.postDataJSON()).toEqual({ reason: "Synthetic owner requests fresh inspection evidence." });
  await expect(rejectedRow).toHaveCount(0);

  const state = await (await page.request.get("/test/health-state")).json();
  expect(state.decisions).toEqual([
    { proposalId: "00000000-0000-4000-8000-000000000083", decision: "accept", reason: "Synthetic owner inspection confirms degraded health." },
    { proposalId: "00000000-0000-4000-8000-000000000084", decision: "reject", reason: "Synthetic owner requests fresh inspection evidence." },
  ]);
  expect(state.eventCount).toBe(1);
});

test("viewer can read owned proposals but cannot submit a Health decision", async ({ page }) => {
  await page.request.get("/test/health-owner?sub=synthetic-viewer");
  await page.goto("/map");
  await expect(page.getByRole("heading", { name: "Scripted SSO" })).toBeVisible();
  await page.getByRole("link", { name: "Sign in as viewer" }).click();
  await expect(page.getByRole("heading", { name: "Geo Command Map", exact: true })).toBeVisible();
  const panel = page.getByRole("complementary", { name: "Map context panel" });
  await expect(panel.locator(".health-proposal-row").first()).toBeVisible();
  await expect(panel.getByText("Your current role cannot record this decision.", { exact: true })).toHaveCount(2);
  await expect(panel.getByRole("button", { name: /Accept Health Proposal/ })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /Reject Health Proposal/ })).toHaveCount(0);
});
