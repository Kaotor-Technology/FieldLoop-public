import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ActionLevelBadge, HealthBadge, MapMarker } from "../src/Badges.js";
import { Navigation, SimulationBanner } from "../src/Navigation.js";

it.each(["healthy", "degraded", "failed", "unverified"] as const)("labels %s Health independently of colour", health => {
  const html = renderToStaticMarkup(<HealthBadge health={health} />);
  expect(html.toLocaleLowerCase()).toContain(health);
  expect(html).toContain('aria-hidden="true"');
});
it("labels a keyboard-operable map marker and Action Level", () => {
  expect(renderToStaticMarkup(<MapMarker health="failed" label="Failed Barrier" />)).toContain('aria-label="Failed Barrier"');
  expect(renderToStaticMarkup(<ActionLevelBadge level="l1" />)).toContain('aria-label="Action Level L1"');
});
it("hides disabled navigation unless a reason is supplied", () => {
  const html = renderToStaticMarkup(<Navigation label="Console" items={[{ href: "/hidden", label: "Hidden", icon: "H", disabled: true }, { href: "/later", label: "Later", icon: "L", disabled: true, disabledReason: "Requires a connection" }]} />);
  expect(html).not.toContain("Hidden");
  expect(html).toContain("Requires a connection");
  expect(html).not.toContain('href="/later"');
});
it("renders a permanent simulation label with mono speed", () => {
  const html = renderToStaticMarkup(<SimulationBanner scenario="Synthetic scenario" speed="1×" />);
  expect(html).toContain("SIMULATION");
  expect(html).toContain('class="fl-mono"');
  expect(html).not.toContain("button");
});
