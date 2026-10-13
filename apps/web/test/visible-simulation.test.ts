import { describe, expect, it } from "vitest";
import { hasVisibleSimulatedData } from "../src/visible-simulation";

describe("visible simulated data detection", () => {
  it("finds simulated entities nested in an active query result", () => {
    expect(hasVisibleSimulatedData([
      { active: true, data: { barriers: [{ id: "barrier-1", simulated: true }] } },
    ])).toBe(true);
  });

  it("ignores inactive queries and simulation configuration queries", () => {
    expect(hasVisibleSimulatedData([
      { active: false, data: { simulated: true } },
      { active: true, includeInBanner: false, data: [{ simulated: true }] },
    ])).toBe(false);
  });

  it("does not classify ordinary records as simulated", () => {
    expect(hasVisibleSimulatedData([
      { active: true, data: [{ simulated: false }, { classification: "INTERNAL" }] },
    ])).toBe(false);
  });
});
