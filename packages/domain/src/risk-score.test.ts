import { describe, expect, it } from "vitest";
import { calculateRiskScore } from "./risk-score.js";

describe("calculateRiskScore", () => {
  it("applies health to PFD, preventive barriers and the demo Risk Matrix", () => {
    const score = calculateRiskScore({
      threats: [{ id: "threat", frequencyPerYear: 0.001 }],
      consequences: [{ id: "consequence", conditionalProbability: 0.1, severityBands: [3, 4] }],
      barriers: [
        { id: "healthy", side: "preventive", pfd: 0.01, health: "healthy", independenceGroupId: null },
        { id: "degraded", side: "preventive", pfd: 0.1, health: "degraded", independenceGroupId: null },
        { id: "mitigative", side: "mitigative", pfd: 0.1, health: "healthy", independenceGroupId: null },
      ],
      paths: [
        { targetType: "threat", targetId: "threat", barrierId: "healthy", position: 1 },
        { targetType: "threat", targetId: "threat", barrierId: "degraded", position: 2 },
        { targetType: "consequence", targetId: "consequence", barrierId: "mitigative", position: 1 },
      ],
    });

    expect(score.topEventFrequencyPerYear).toBeCloseTo(0.00001);
    expect(score.cells).toHaveLength(1);
    expect(score.cells[0]).toMatchObject({
      consequenceId: "consequence", frequencyBand: 1, severityBand: 4, zone: "acceptable",
    });
    expect(score.cells[0]?.frequencyPerYear).toBeCloseTo(0.0000001);
    expect(score.worstZone).toBe("acceptable");
  });

  it("credits only the strongest Barrier in one Independence Group", () => {
    const score = calculateRiskScore({
      threats: [{ id: "threat", frequencyPerYear: 1 }], consequences: [],
      barriers: [
        { id: "strong", side: "preventive", pfd: 0.01, health: "healthy", independenceGroupId: "shared" },
        { id: "weak", side: "preventive", pfd: 0.1, health: "healthy", independenceGroupId: "shared" },
      ],
      paths: [
        { targetType: "threat", targetId: "threat", barrierId: "strong", position: 1 },
        { targetType: "threat", targetId: "threat", barrierId: "weak", position: 2 },
      ],
    });

    expect(score.topEventFrequencyPerYear).toBeCloseTo(0.01);
  });

  it("treats Failed as no reduction and Unverified as Degraded", () => {
    const score = calculateRiskScore({
      threats: [
        { id: "failed-threat", frequencyPerYear: 0.1 },
        { id: "unverified-threat", frequencyPerYear: 0.1 },
      ], consequences: [],
      barriers: [
        { id: "failed", side: "preventive", pfd: 0.01, health: "failed", independenceGroupId: null },
        { id: "unverified", side: "preventive", pfd: 0.01, health: "unverified", independenceGroupId: null },
      ],
      paths: [
        { targetType: "threat", targetId: "failed-threat", barrierId: "failed", position: 1 },
        { targetType: "threat", targetId: "unverified-threat", barrierId: "unverified", position: 1 },
      ],
    });

    expect(score.topEventFrequencyPerYear).toBeCloseTo(0.11);
  });

  it("places the design reference cell 4×3 in ALARP", () => {
    const score = calculateRiskScore({
      threats: [{ id: "threat", frequencyPerYear: 0.001 }],
      consequences: [{ id: "consequence", conditionalProbability: 1, severityBands: [3] }],
      barriers: [], paths: [],
    });

    expect(score.cells[0]).toMatchObject({ frequencyBand: 4, severityBand: 3, zone: "alarp" });
  });
});
