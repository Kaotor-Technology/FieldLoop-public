import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { ActionRequest } from "./action-approval";
import { ActionApprovalBody } from "./ActionApprovalDialog";
import i18n from "./i18n";

afterEach(async () => { await i18n.changeLanguage("en"); });

const hash = "a".repeat(64);
const now = Date.parse("2026-10-15T10:00:00.000Z");
const action = (overrides: Partial<ActionRequest> = {}): ActionRequest => ({
  id: "96000000-0000-4000-8000-000000000001", orgId: "synthetic-org", actionType: "emergency_communication", actionLevel: "l2", target: "stakeholders",
  payload: { scenario: "storm-b", message: "SIMULATION: <b>drill</b>" }, payloadHash: hash, rationale: "Drill rationale", citations: ["synthetic:plan-1"],
  requestedBy: "synthetic-operator", requester: { kind: "person" }, status: "open", expiresAt: "2026-10-15T10:15:00.000Z", simulated: true,
  classification: "INTERNAL", ...overrides,
});

describe("approval dialog body", () => {
  const render = (overrides: Partial<Parameters<typeof ActionApprovalBody>[0]> = {}) => renderToStaticMarkup(
    <ActionApprovalBody action={action()} block={null} now={now} reason="" onReason={() => undefined} failure={null} decided={null} submitting={false} needsLogin={false} {...overrides} />);
  it("shows the exact payload and hash in mono, the does / does-not pair and the SIMULATION label, with escaped text", () => {
    const markup = render();
    expect(markup).toContain("approval-payload mono");
    expect(markup).toContain(hash);
    expect(markup).toContain("This does");
    expect(markup).toContain("This does not");
    expect(markup).toContain("SIMULATION");
    expect(markup).toContain("&lt;b&gt;drill&lt;/b&gt;");
    expect(markup).not.toContain("<b>drill</b>");
    expect(markup).toContain('<time class="mono"');
  });
  it("has no Approve or Reject control inside the content and the reason field is required", () => {
    const markup = render();
    expect(markup).not.toContain(">Approve<");
    expect(markup).not.toContain(">Reject<");
    expect(markup).toMatch(/<textarea[^>]*required/);
  });
  it("replaces the form with the reason a decision is blocked and shows server failures as alerts", () => {
    const blocked = render({ block: "four_eyes" });
    expect(blocked).toContain("Another person must decide it.");
    expect(blocked).not.toContain("<textarea");
    const failed = render({ failure: "payload_changed", onReload: () => undefined });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Reload request");
  });
  it("asks for a fresh login instead of offering a decision when the login is old", () => {
    expect(render({ needsLogin: true })).toContain("sign in again");
  });
  it("renders in Thai with the same structure", async () => {
    await i18n.changeLanguage("th");
    expect(render()).toContain("สิ่งที่การอนุมัตินี้ทำ");
  });
});
