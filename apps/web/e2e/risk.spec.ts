import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const bowtieId = "50000000-0000-4000-8000-000000000001";
const threatId = "50000000-0000-4000-8000-000000000002";
const consequenceId = "50000000-0000-4000-8000-000000000003";
const barrierId = "50000000-0000-4000-8000-000000000004";
const snapshot = {
  bowtieId, topEventFrequencyPerYear: 0.002,
  threats: [],
  consequences: [{
    consequenceId, frequencyPerYear: 0.0002, severityBand: 3,
    path: { pathId: "mitigative", targetId: consequenceId, pfd: 0.1, barriers: [] },
    cell: { frequencyBand: 2, severityBand: 3, zone: "amber", rank: 12 },
  }],
  worstConsequenceId: consequenceId,
  cell: { frequencyBand: 2, severityBand: 3, zone: "amber", rank: 12 },
};
const current = {
  id: "50000000-0000-4000-8000-000000000005", createdAt: "2026-10-13T01:00:00.000Z", trigger: "health_change",
  calibration: { standardRef: "SYNTHETIC-ORG-RISK-STD", standardVersion: "2026.1", approvedBy: "synthetic-authority", approvedAt: "2026-10-13T00:00:00.000Z" }, snapshot,
};
const previous = {
  id: "50000000-0000-4000-8000-000000000006", createdAt: "2026-10-13T00:00:00.000Z", trigger: "initial",
  calibration: { ...current.calibration, standardVersion: "2026.0" }, snapshot: { ...snapshot, topEventFrequencyPerYear: 0.001 },
};

async function mockRiskApi(page: Page, configured: boolean) {
  await page.route(`**/api/v1/bowties/${bowtieId}/risk/explain`, (route) => configured
    ? route.fulfill({ json: {
      bowtieId, hasPrevious: true, summary: "Risk changed after the listed Barrier and risk input changes.", previous, current,
      riskInputChanges: [{ path: `riskInput/threats/${threatId}/frequencyPerYear`, beforeValue: "0.01", afterValue: "0.02" }],
      changes: [{
        barrierId, beforeHealth: "healthy", afterHealth: "degraded", reason: "Health accepted by a reviewer.",
        sourceEvidenceId: null, sourceEvidenceHref: null, topEventFrequencyDeltaPerYear: 0.001,
        consequenceFrequencyDeltasPerYear: [{ consequenceId, delta: 0.0001 }], impact: 0.0001,
      }],
    } })
    : route.fulfill({ status: 409, contentType: "application/problem+json", body: JSON.stringify({ status: 409, code: "risk_matrix_unconfigured", title: "Organisation Risk Matrix is not approved" }) }));
  await page.route(`**/api/v1/bowties/${bowtieId}/risk`, (route) => configured
    ? route.fulfill({ json: current })
    : route.fulfill({ status: 409, contentType: "application/problem+json", body: JSON.stringify({ status: 409, code: "risk_matrix_unconfigured", title: "Organisation Risk Matrix is not approved" }) }));
  await page.route(`**/api/v1/bowties/${bowtieId}`, (route) => route.fulfill({ json: {
    id: bowtieId, hazard: "Synthetic flood hazard", topEvent: "Synthetic flood barrier failure", domain: "flood", status: "active",
    simulated: true, classification: "INTERNAL",
    severityCriteria: {
      people: ["P1", "P2", "P3", "P4", "P5"], environment: ["E1", "E2", "E3", "E4", "E5"],
      financial: ["F1", "F2", "F3", "F4", "F5"], serviceContinuity: ["S1", "S2", "S3", "S4", "S5"],
      reputation: ["R1", "R2", "R3", "R4", "R5"], legalRegulatory: ["L1", "L2", "L3", "L4", "L5"],
    },
    threats: [{ id: threatId, name: "Synthetic rainfall", frequencyPerYear: 0.01 }],
    barriers: [{ id: barrierId, name: "Synthetic flood gate", type: "technical", side: "preventive", health: "degraded", pfdBand: 0.01, degradationFactors: ["Synthetic power interruption"] }],
    consequences: [{ id: consequenceId, name: "Synthetic community impact", severity: { people: 3, environment: 4, financial: 2, serviceContinuity: 3, reputation: 2, legalRegulatory: 1 } }],
    paths: [
      { id: "preventive", side: "preventive", targetId: threatId, barrierIds: [barrierId] },
      { id: "mitigative", side: "mitigative", targetId: consequenceId, barrierIds: [] },
    ],
  } }));
  await page.route("**/api/v1/bowties", (route) => route.fulfill({ json: [{
    id: bowtieId, hazard: "Synthetic flood hazard", topEvent: "Synthetic flood barrier failure", domain: "flood", status: "active",
    simulated: true, classification: "INTERNAL",
  }] }));
}

test.beforeEach(async ({ request }) => { await request.get("/test/reset"); });

test("Bowtie canvas shows Organisation severity dimensions and explains changed Barrier Health", async ({ page }) => {
  await mockRiskApi(page, true);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("/map");
  await page.getByRole("link", { name: "Sign in as viewer" }).click();
  await page.getByRole("link", { name: /Synthetic flood barrier failure/ }).click();

  await expect(page.getByRole("heading", { name: "Synthetic flood barrier failure", exact: true })).toBeVisible();
  for (const dimension of ["People", "Environment", "Asset / Financial", "Reputation", "Service continuity", "Legal / Regulatory"]) {
    await expect(page.getByText(dimension, { exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Explain score" }).click();
  await expect(page.getByRole("heading", { name: "Explain score" })).toBeVisible();
  await expect(page.getByText("Health accepted by a reviewer.")).toBeVisible();
  await expect(page.getByText(/Healthy → Degraded/)).toBeVisible();
  await expect(page.getByText(`riskInput/threats/${threatId}/frequencyPerYear`)).toBeVisible();
  await expect(page.getByText("0.01 → 0.02")).toBeVisible();
  await expect(page.getByText("SYNTHETIC-ORG-RISK-STD").first()).toBeVisible();
  await expect(page.getByText("2026.1", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
});

test("Bowtie canvas displays a pending notice when Organisation calibration is unconfigured", async ({ page }) => {
  await mockRiskApi(page, false);
  await page.goto("/map");
  await page.getByRole("link", { name: "Sign in as viewer" }).click();
  const riskResponsePromise = page.waitForResponse((response) => response.url().endsWith(`/api/v1/bowties/${bowtieId}/risk`));
  await page.getByRole("link", { name: /Synthetic flood barrier failure/ }).click();
  const riskResponse = await riskResponsePromise;
  expect(riskResponse.status()).toBe(409);
  expect(await riskResponse.json()).toMatchObject({ code: "risk_matrix_unconfigured" });

  await expect(page.getByRole("heading", { name: "Risk calibration needs Technical Authority approval" })).toBeVisible();
  await expect(page.getByText("Organisation Risk Score")).toHaveCount(0);
  await page.getByRole("button", { name: "Explain score" }).click();
  await expect(page.getByText(/controlled standard reference and version/)).toBeVisible();
});
