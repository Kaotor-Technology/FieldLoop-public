import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

const fixture = {
  schemaVersion: 1, assetCode: "SYNTHETIC-FIXTURE", lengthM: 100,
  classification: "PUBLIC", simulated: true, label: "SYNTHETIC",
  segments: [{ id: "fixture-segment", name: "Fixture Segment", chainageFromM: 0, chainageToM: 100 }],
  facilities: [], barriers: [{ id: "fixture-barrier", name: "Fixture Barrier", health: "unverified", chainageM: null }],
  inspections: [], threatCategories: [],
} as const;
it("renders an explicitly simulated read-only Chainage band with accessible Segment and unlocated Barrier text", async () => {
  const path = "../src/StripBand";
  const module = await import(path).catch(() => ({}));
  expect(module.StripBand, "static component is required").toBeTypeOf("function");
  const html = renderToStaticMarkup(createElement(module.StripBand, { data: fixture }));
  expect(html).toContain("SIMULATION");
  expect(html).toContain("SYNTHETIC");
  expect(html).toContain("Chainage");
  expect(html).toContain("Fixture Segment");
  expect(html).toContain("Fixture Barrier");
  expect(html).toContain("Unverified");
  expect(html).toContain("No confirmed Chainage");
  expect(html).toContain('lang="en"');
  expect(html).not.toMatch(/<button|<input|<a /);
});

it("localizes Thai copy and renders Facilities without relabelling them as Barriers", async () => {
  const { StripBand } = await import("../src/StripBand");
  const html = renderToStaticMarkup(createElement(StripBand, { data: { ...fixture,
    facilities: [{ id: "fixture-facility", name: "Fixture Facility", chainageM: 25 }] }, language: "th" }));
  expect(html).toContain('lang="th"');
  expect(html).toContain("ระยะทางตามแนวเส้น");
  expect(html).toContain("ไม่มีระยะทางที่ยืนยัน");
  expect(html).toContain("ยังไม่ยืนยัน");
  expect(html).toContain("Fixture Facility");
  expect(html).toContain("25 m");
});
