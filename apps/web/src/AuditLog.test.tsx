import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditEvent } from "./audit-events";
import { canReadAudit, formatAuditTime } from "./audit-events";
import { AuditLog } from "./AuditLog";
import i18n from "./i18n";

afterEach(async () => { await i18n.changeLanguage("en"); });

const digest = (letter: string) => letter.repeat(64);
const event = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  id: "00000000-0000-4000-8000-000000000001", entityType: "barrier", entity: "barrier-synthetic-1", action: "barrier.health_changed",
  actor: "synthetic-user", beforeHash: digest("a"), afterHash: digest("b"), prevHash: digest("c"), hash: digest("d"),
  createdAt: "2026-10-14T08:39:59.123456Z", simulated: false, classification: "CONFIDENTIAL", ...overrides,
});
const render = (props: Partial<Parameters<typeof AuditLog>[0]> = {}) =>
  renderToStaticMarkup(<AuditLog events={[event()]} filter={{}} onFilter={() => undefined} {...props} />);

describe("Audit log view", () => {
  it("shows the decision reason with the event actor as escaped text", () => {
    const reason = "Synthetic owner accepted <script>unsafe</script>";
    const markup = render({ events: [{ ...event({ action: "health_proposal.accepted" }), reason } as AuditEvent] });
    expect(markup).toContain("synthetic-user");
    expect(markup).toContain("Synthetic owner accepted &lt;script&gt;unsafe&lt;/script&gt;");
    expect(markup).not.toContain("<script>unsafe</script>");
  });

  it("renders events as a captioned table with mono IDs, times and hashes", () => {
    const markup = render();
    expect(markup).toContain("<caption");
    expect(markup).toContain('scope="col"');
    expect(markup).toContain('<time class="mono" dateTime="2026-10-14T08:39:59.123456Z">2026-10-14 08:39:59.123456 UTC</time>');
    for (const value of ["barrier.health_changed", "barrier-synthetic-1", "synthetic-user", digest("d"), digest("c"), digest("a"), digest("b")]) {
      expect(markup).toContain(value);
    }
    expect(markup).toContain("Confidential");
    expect(markup).not.toContain(">CONFIDENTIAL<");
    expect(markup).toContain('id="main-content"');
  });

  it("makes the horizontally scrollable table reachable by keyboard", () => {
    const markup = render();
    expect(markup).toContain('class="audit-table-wrap" role="region" aria-label="Audit events, newest first" tabindex="0"');
  });

  it("labels simulated events and marks the start of a chain", () => {
    const markup = render({ events: [event({ simulated: true, prevHash: null, beforeHash: null })] });
    expect(markup).toContain(">SIMULATION<");
    expect(markup).toContain("Start of chain");
    expect(markup).toContain("Not recorded");
    expect(render()).not.toContain(">SIMULATION<");
  });

  it("offers no control that changes an audit event", () => {
    const markup = render();
    expect(markup).not.toMatch(/<button[^>]*>(Delete|Edit|Remove|Update)/i);
    expect(markup).not.toMatch(/contenteditable/i);
  });

  it("shows loading, error and empty states with the right live-region roles", () => {
    expect(render({ events: [], isLoading: true })).toContain('role="status"');
    expect(render({ events: [], hasError: true })).toContain('role="alert"');
    expect(render({ events: [] })).toContain("No audit events are recorded");
    expect(render({ events: [], filter: { entityType: "barrier" } })).toContain("No audit events match this filter.");
  });

  it("shows the active filter in the form and a load-more control when more pages exist", () => {
    const markup = render({ filter: { entityType: "barrier", entityId: "barrier-synthetic-1" }, hasMore: true, onLoadMore: () => undefined });
    expect(markup).toContain('value="barrier"');
    expect(markup).toContain('value="barrier-synthetic-1"');
    expect(markup).toContain("Load more events");
    expect(render()).not.toContain("Load more events");
  });

  it("renders in Thai without raw translation keys or English classification codes", async () => {
    await i18n.changeLanguage("th");
    const markup = render();
    expect(markup).toContain("บันทึกการตรวจสอบ");
    expect(markup).toContain("ลับ");
    expect(markup).not.toMatch(/audit[A-Z][A-Za-z]+/);
    expect(markup).not.toContain(">CONFIDENTIAL<");
  });

  it("allows only operators and managers to read audit", () => {
    expect(canReadAudit(["fieldloop.operator"])).toBe(true);
    expect(canReadAudit(["fieldloop.manager"])).toBe(true);
    expect(canReadAudit(["fieldloop.viewer"])).toBe(false);
    expect(canReadAudit([])).toBe(false);
  });

  it("formats the stored UTC microsecond time unambiguously", () => {
    expect(formatAuditTime("2026-10-14T08:39:59.000001Z")).toBe("2026-10-14 08:39:59.000001 UTC");
  });
});
