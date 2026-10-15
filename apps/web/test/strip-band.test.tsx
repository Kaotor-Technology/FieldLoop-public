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

it("sorts located rows by Chainage and groups unlocated Barriers after located ones", async () => {
  const { StripBand } = await import("../src/StripBand");
  const html = renderToStaticMarkup(createElement(StripBand, { data: { ...fixture,
    segments: [
      { id: "later-segment", name: "Segment 002", chainageFromM: 50, chainageToM: 100 },
      { id: "earlier-segment", name: "Segment 001", chainageFromM: 0, chainageToM: 50 },
    ],
    facilities: [
      { id: "later-facility", name: "Station 002", chainageM: 75 },
      { id: "earlier-facility", name: "Station 001", chainageM: 25 },
    ],
    barriers: [
      { id: "later-barrier", name: "Located 75", health: "healthy", chainageM: 75 },
      { id: "unlocated-barrier", name: "Unlocated", health: "unverified", chainageM: null },
      { id: "earlier-barrier", name: "Located 25", health: "degraded", chainageM: 25 },
    ],
  } }));
  expect(html.indexOf("Segment 001")).toBeLessThan(html.indexOf("Segment 002"));
  expect(html.indexOf("Station 001")).toBeLessThan(html.indexOf("Station 002"));
  expect(html.indexOf("Located 25")).toBeLessThan(html.indexOf("Located 75"));
  expect(html.indexOf("Located 75")).toBeLessThan(html.indexOf("Unlocated"));
});
