import { describe, expect, it } from "vitest";
import { isRiskSnapshot, riskInputErrors, type RiskInput } from "../src/risk.js";

function input(): RiskInput {
  return {
    bowtieId: "synthetic-bowtie", barriers: [], independenceGroups: [],
    threats: [{ id: "threat", frequencyPerYear: 0.1 }],
    consequences: [{ id: "consequence", conditionalProbability: 0.5, severity: { people: 5 } }],
    paths: [
      { id: "prevention", side: "preventive", targetId: "threat", barrierIds: [] },
      { id: "mitigation", side: "mitigative", targetId: "consequence", barrierIds: [] },
    ],
    matrix: {
      frequencyThresholds: [1e-5, 1e-4, 1e-3, 1e-2],
      cells: Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => ({ rank: 1, zone: "green" as const }))),
    },
  };
}

describe("risk contracts", () => {
  it("accepts explicit unprotected paths and does not default or mutate input", () => {
    const value = input();
    const before = structuredClone(value);
    expect(riskInputErrors(value)).toEqual([]);
    expect(value).toEqual(before);
  });

  it.each([NaN, Infinity, -Infinity, -0.1])("rejects invalid frequencies: %s", frequencyPerYear => {
    const value = input();
    value.threats = [{ id: "threat", frequencyPerYear }];
    expect(riskInputErrors(value)).not.toEqual([]);
  });

  it("rejects missing Barrier PFD, unknown Health and zero PFD", () => {
    const value = input();
    for (const barrier of [
      { id: "b", type: "technical", side: "preventive", health: "healthy" },
      { id: "b", type: "technical", side: "preventive", health: "unknown", pfdBand: 0.01 },
      { id: "b", type: "technical", side: "preventive", health: "healthy", pfdBand: 0 },
    ]) expect(riskInputErrors({ ...value, barriers: [barrier] })).not.toEqual([]);
  });

  it("rejects empty/unknown/out-of-range severity and incomplete matrices", () => {
    const value = input();
    for (const severity of [{}, { unknown: 5 }, { people: 6 }, { financial: 1.5 }]) {
      expect(riskInputErrors({ ...value, consequences: [{ ...value.consequences[0], severity }] })).not.toEqual([]);
    }
    expect(riskInputErrors({ ...value, matrix: { ...value.matrix, cells: [] } })).not.toEqual([]);
    expect(isRiskSnapshot({ bowtieId: "synthetic-bowtie" })).toBe(false);
  });
});
