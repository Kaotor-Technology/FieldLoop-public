import { readFileSync } from "node:fs";
import { type RiskInput, type RiskMatrix, type RiskSeverity } from "@fieldloop/contracts";

/** Test-only calibration, not an approved Organisation tolerability matrix. */
export function testMatrix(): RiskMatrix {
  return {
    frequencyThresholds: [1e-5, 1e-4, 1e-3, 1e-2],
    cells: Array.from({ length: 5 }, (_, frequency) => Array.from({ length: 5 }, (_, severity) => {
      const rank = (frequency + 1) * (severity + 1);
      return { rank, zone: rank >= 15 ? "red" : rank >= 5 ? "amber" : "green" };
    })),
  };
}

export function basicInput(): RiskInput {
  return {
    bowtieId: "synthetic", matrix: testMatrix(), independenceGroups: [],
    barriers: [{ id: "barrier", type: "technical", side: "preventive", pfdBand: 0.01, health: "healthy" }],
    threats: [{ id: "threat", frequencyPerYear: 1 }],
    consequences: [{ id: "consequence", conditionalProbability: 1, severity: { people: 3 } }],
    paths: [
      { id: "preventive", side: "preventive", targetId: "threat", barrierIds: ["barrier"] },
      { id: "mitigative", side: "mitigative", targetId: "consequence", barrierIds: [] },
    ],
  };
}

type Seed = {
  id: string;
  barriers: RiskInput["barriers"];
  threats: RiskInput["threats"];
  consequences: { id: string; conditionalProbability: number; severity: Record<string, number> }[];
  independenceGroups: RiskInput["independenceGroups"];
  paths: RiskInput["paths"];
};

/** Project authored synthetic seeds onto the calculation contract; no DB or network access. */
export function seedInput(relativePath: string): RiskInput {
  const seed = JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8")) as Seed;
  return {
    bowtieId: seed.id, matrix: testMatrix(),
    barriers: seed.barriers.map(barrier => ({
      id: barrier.id, type: barrier.type, side: barrier.side, pfdBand: barrier.pfdBand, health: barrier.health,
      ...(barrier.independenceGroupId === undefined ? {} : { independenceGroupId: barrier.independenceGroupId }),
    })),
    threats: seed.threats.map(({ id, frequencyPerYear }) => ({ id, frequencyPerYear })),
    consequences: seed.consequences.map(({ id, conditionalProbability, severity }) => ({
      id, conditionalProbability,
      severity: Object.fromEntries(Object.entries(severity).map(([dimension, band]) => [dimension === "service_continuity" ? "serviceContinuity" : dimension, band])) as RiskSeverity,
    })),
    independenceGroups: seed.independenceGroups.map(({ id }) => ({ id })),
    paths: seed.paths,
  };
}
