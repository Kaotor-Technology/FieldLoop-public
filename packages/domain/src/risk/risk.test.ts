import { describe, expect, it } from "vitest";
import { isRiskSnapshot, type BarrierHealth, type RiskBand, type RiskInput } from "@fieldloop/contracts";
import { calculateRisk, RiskInputError } from "./index.js";
import { basicInput } from "./test-fixtures.js";

describe("PFD × Health", () => {
  it.each<[BarrierHealth, number]>([["healthy", 0.01], ["degraded", 0.1], ["unverified", 0.1], ["failed", 1]])("calculates %s", (health, expected) => {
    const value = basicInput();
    value.barriers = value.barriers.map(barrier => ({ ...barrier, health }));
    expect(calculateRisk(value).topEventFrequencyPerYear).toBe(expected);
  });

  it("caps Degraded at one and projects expired Healthy Evidence to Unverified without mutation", () => {
    const value = basicInput();
    value.barriers = value.barriers.map(barrier => ({ ...barrier, pfdBand: 0.3, evidenceExpired: true }));
    const before = structuredClone(value);
    const result = calculateRisk(value);
    expect(result.topEventFrequencyPerYear).toBe(1);
    expect(result.threats[0]?.path.barriers[0]?.health).toBe("unverified");
    expect(value).toEqual(before);
    expect(isRiskSnapshot(result)).toBe(true);
  });

  it("enforces the AS-4 ceilings, including certification only for Technical Barriers", () => {
    for (const type of ["technical", "organisational", "human"] as const) {
      const value = basicInput();
      value.barriers = value.barriers.map(barrier => ({ ...barrier, type, pfdBand: 0.001 }));
      expect(() => calculateRisk(value)).toThrow(/Barrier barrier.*ceiling/);
      value.barriers = value.barriers.map(barrier => ({ ...barrier, certified: true }));
      if (type === "technical") expect(calculateRisk(value).topEventFrequencyPerYear).toBe(0.001);
      else expect(() => calculateRisk(value)).toThrow(/ceiling/);
    }
  });

  it("Q60 property: expired Evidence never reduces a Failed Barrier's PFD or Risk Score", () => {
    // Exhaust the Health states of a group peer and 101 valid PFD values.
    for (let index = 0; index <= 100; index++) {
      for (const health of ["healthy", "degraded", "unverified", "failed"] as const) {
        const value = basicInput();
        const pfdBand = 0.01 + index * 0.0099;
        value.independenceGroups = [{ id: "power" }];
        value.barriers = [
          { id: "failed", type: "technical", side: "preventive", pfdBand, health: "failed", independenceGroupId: "power" },
          { id: "peer", type: "technical", side: "preventive", pfdBand: 0.1, health, independenceGroupId: "power" },
        ];
        value.paths = value.paths.map(path => path.side === "preventive" ? { ...path, barrierIds: ["failed", "peer"] } : path);
        const before = calculateRisk(value);
        value.barriers = value.barriers.map(barrier => barrier.id === "failed" ? { ...barrier, evidenceExpired: true } : barrier);
        expect(calculateRisk(value)).toEqual(before);
      }
    }
  });
});

describe("Independence Groups and paths", () => {
  it("credits the lowest effective PFD per path, even when it is not the lowest base PFD", () => {
    const value = basicInput();
    value.independenceGroups = [{ id: "power" }];
    value.barriers = [
      { id: "a", type: "technical", side: "preventive", pfdBand: 0.01, health: "degraded", independenceGroupId: "power" },
      { id: "b", type: "technical", side: "preventive", pfdBand: 0.05, health: "healthy", independenceGroupId: "power" },
    ];
    value.paths = value.paths.map(path => path.side === "preventive" ? { ...path, barrierIds: ["a", "b"] } : path);
    const result = calculateRisk(value);
    expect(result.topEventFrequencyPerYear).toBe(0.05);
    expect(result.threats[0]?.path.barriers.map(barrier => barrier.credited)).toEqual([false, true]);
    // The same shared Barrier gets credit again on a separate Threat path.
    value.threats.push({ id: "other-threat", frequencyPerYear: 2 });
    value.paths.push({ id: "other-path", side: "preventive", targetId: "other-threat", barrierIds: ["a"] });
    expect(calculateRisk(value).topEventFrequencyPerYear).toBeCloseTo(0.25, 15);
  });

  it("allows explicit unprotected paths with product one and zero threat/conditional frequencies", () => {
    const value = basicInput();
    value.barriers = [];
    value.paths = value.paths.map(path => ({ ...path, barrierIds: [] }));
    expect(calculateRisk(value).topEventFrequencyPerYear).toBe(1);
    value.consequences = value.consequences.map(consequence => ({ ...consequence, conditionalProbability: 0 }));
    expect(calculateRisk(value).consequences[0]?.frequencyPerYear).toBe(0);
    value.threats = value.threats.map(threat => ({ ...threat, frequencyPerYear: 0 }));
    expect(calculateRisk(value).topEventFrequencyPerYear).toBe(0);
  });
});

describe("Risk Matrix", () => {
  it.each<[number, RiskBand]>([
    [0, 1], [0.999e-5, 1], [1e-5, 2], [0.999e-4, 2], [1e-4, 3],
    [0.999e-3, 3], [1e-3, 4], [0.999e-2, 4], [1e-2, 5], [1, 5],
  ])("places frequency %s in band %s", (frequencyPerYear, band) => {
    const value = basicInput();
    value.barriers = [];
    value.paths = value.paths.map(path => ({ ...path, barrierIds: [] }));
    value.threats = [{ id: "threat", frequencyPerYear }];
    expect(calculateRisk(value).cell.frequencyBand).toBe(band);
  });

  it("uses the worst of all six severity dimensions and Organisation calibration", () => {
    const value = basicInput();
    value.consequences = [{ id: "consequence", conditionalProbability: 1, severity: {
      people: 1, environment: 2, financial: 3, serviceContinuity: 4, reputation: 5, legalRegulatory: 5,
    } }];
    value.matrix.frequencyThresholds = [0.1, 1, 10, 100];
    expect(calculateRisk(value).cell).toEqual({ frequencyBand: 1, severityBand: 5, rank: 5, zone: "amber" });
  });

  it("selects a worse zone before rank and breaks equal-cell ties by stable Consequence ID", () => {
    const value = basicInput();
    value.consequences = [
      { id: "z", conditionalProbability: 1, severity: { people: 1 } },
      { id: "a", conditionalProbability: 0.001, severity: { people: 5 } },
      { id: "b", conditionalProbability: 0.001, severity: { people: 5 } },
    ];
    value.paths = [
      ...value.paths.filter(path => path.side === "preventive"),
      ...value.consequences.map(consequence => ({ id: `path-${consequence.id}`, side: "mitigative" as const, targetId: consequence.id, barrierIds: [] })),
    ];
    // All severity-5 cells are red; lower severities stay green.
    value.matrix.cells = value.matrix.cells.map(row => row.map((_, column) => ({ zone: column === 4 ? "red" : "green", rank: 1 })));
    expect(calculateRisk(value).worstConsequenceId).toBe("a");
    value.consequences.reverse();
    expect(calculateRisk(value).worstConsequenceId).toBe("a");
  });
});

describe("invalid input fails as a whole", () => {
  it.each<[string, (input: RiskInput) => void, RegExp]>([
    ["duplicate Barrier", value => value.barriers.push({ ...value.barriers[0] } as RiskInput["barriers"][number]), /Duplicate Barrier/],
    ["duplicate Threat", value => value.threats.push({ id: "threat", frequencyPerYear: 1 }), /Duplicate Threat/],
    ["duplicate Consequence", value => value.consequences.push({ id: "consequence", conditionalProbability: 1, severity: { people: 1 } }), /Duplicate Consequence/],
    ["duplicate path", value => value.paths.push({ id: "preventive", side: "preventive", targetId: "threat", barrierIds: [] }), /Duplicate path/],
    ["missing path", value => { value.paths = value.paths.filter(path => path.side === "mitigative"); }, /Threat threat.*no explicit/],
    ["missing mitigation", value => { value.paths = value.paths.filter(path => path.side === "preventive"); }, /Consequence consequence.*no explicit/],
    ["multiple paths", value => value.paths.push({ id: "second", side: "preventive", targetId: "threat", barrierIds: [] }), /Multiple preventive paths/],
    ["orphan path", value => value.paths.push({ id: "orphan", side: "preventive", targetId: "missing", barrierIds: [] }), /Orphan path/],
    ["wrong Barrier side", value => { value.barriers = value.barriers.map(barrier => ({ ...barrier, side: "mitigative" })); }, /wrong side/],
    ["missing Barrier", value => { value.barriers = []; }, /missing Barrier barrier/],
    ["missing group", value => { value.barriers = value.barriers.map(barrier => ({ ...barrier, independenceGroupId: "typo" })); }, /missing Independence Group/],
    ["duplicate group", value => { value.independenceGroups = [{ id: "g" }, { id: "g" }]; }, /Duplicate Independence Group/],
    ["threshold ordering", value => { value.matrix.frequencyThresholds = [1e-5, 1e-5, 1e-3, 1e-2]; }, /strictly increasing/],
    ["matrix ordering", value => { value.matrix.cells[4] = value.matrix.cells[0] ?? []; }, /improves/],
  ])("rejects %s", (_name, mutate, message) => {
    const value = basicInput();
    mutate(value);
    expect(() => calculateRisk(value)).toThrow(RiskInputError);
    expect(() => calculateRisk(value)).toThrow(message);
  });

  it("identifies the Barrier when PFD is missing and rejects nonfinite numbers", () => {
    const value = basicInput();
    const invalid = { ...value, barriers: [{ id: "missing-pfd", side: "preventive", type: "technical", health: "healthy" }] };
    expect(() => calculateRisk(invalid as RiskInput)).toThrow(/Barrier missing-pfd.*pfdBand/);
    for (const frequencyPerYear of [NaN, Infinity, -1]) {
      expect(() => calculateRisk({ ...value, threats: [{ id: "threat", frequencyPerYear }] })).toThrow(RiskInputError);
    }
  });

  it("rejects numerical underflow and overflow rather than returning a false zero or Infinity", () => {
    const value = basicInput();
    value.threats = [{ id: "threat", frequencyPerYear: Number.MIN_VALUE }];
    expect(() => calculateRisk(value)).toThrow(/underflow/);
    value.barriers = [];
    value.threats = [{ id: "threat", frequencyPerYear: Number.MAX_VALUE }, { id: "second", frequencyPerYear: Number.MAX_VALUE }];
    value.paths = value.paths.map(path => ({ ...path, barrierIds: [] }));
    value.paths.push({ id: "second-path", side: "preventive", targetId: "second", barrierIds: [] });
    expect(() => calculateRisk(value)).toThrow(/overflow/);
  });
});
