import { describe, expect, it } from "vitest";
import { isRiskSnapshot, type RiskInput, type RiskSnapshot } from "@fieldloop/contracts";
import { calculateRisk } from "./index.js";
import { seedInput, testMatrix } from "./test-fixtures.js";

const BOWTIE_A = "../../../../data/synthetic/dl-01/bowtie-a.json";
const BOWTIE_D = "../../../../data/synthetic/bangkok/bowtie-d.json";

function expectBinary64Equal(actual: number, expected: number): void {
  // Bound relative error by eight machine epsilons; no decimal rounding in the engine.
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.abs(expected) * Number.EPSILON * 8);
}

/** Assert every non-frequency field against the authored synthetic input and
 * explicit hand-selected common-cause credits, not a generated snapshot.
 */
function expectAuthoredMetadata(input: RiskInput, result: RiskSnapshot, uncredited: readonly string[]): void {
  expect(result.bowtieId).toBe(input.bowtieId);
  expect(result.threats.map(threat => threat.threatId)).toEqual(input.threats.map(threat => threat.id).sort());
  expect(result.consequences.map(consequence => consequence.consequenceId)).toEqual(input.consequences.map(consequence => consequence.id).sort());
  for (const threat of result.threats) expect(threat.path.targetId).toBe(threat.threatId);
  for (const consequence of result.consequences) expect(consequence.path.targetId).toBe(consequence.consequenceId);
  for (const { path } of [...result.threats, ...result.consequences]) {
    const authored = input.paths.find(value => value.id === path.pathId);
    expect(authored).toBeDefined();
    expect(path.targetId).toBe(authored?.targetId);
    expect(path.barriers.map(barrier => barrier.barrierId)).toEqual([...(authored?.barrierIds ?? [])].sort());
    for (const credit of path.barriers) {
      const barrier = input.barriers.find(value => value.id === credit.barrierId);
      expect(barrier).toBeDefined();
      expect(credit.health).toBe(barrier?.health);
      expect(credit.effectivePfd).toBe(credit.barrierId === "dual-power-generators" ? 0.1 : barrier?.pfdBand);
      expect(credit.credited).toBe(!uncredited.includes(credit.barrierId));
    }
  }
}

describe("PRD §6.1 synthetic Bowtie A golden", () => {
  it("reproduces all hand-calculated paths, frequencies and severity bands", () => {
    const input = seedInput(BOWTIE_A);
    const result = calculateRisk(input);
    expectAuthoredMetadata(input, result, ["remote-automatic-valve-closure"]);
    // 0.001 × (0.01 × 0.1 × 0.1) + 3 × 0.001 × (0.01 × 0.01 × 0.1).
    expect(result.topEventFrequencyPerYear).toBeCloseTo(1.3e-7, 18);
    for (const threat of result.threats) {
      expect(threat.path.pfd).toBeCloseTo(threat.threatId === "third-party-excavation" ? 1e-4 : 1e-5, 18);
      expect(threat.frequencyPerYear).toBeCloseTo(threat.threatId === "third-party-excavation" ? 1e-7 : 1e-8, 18);
    }
    for (const consequence of result.consequences) {
      // The two common-power Technical Barriers credit 0.01 once, then ERP × 0.1.
      expect(consequence.path.pfd).toBeCloseTo(1e-3, 18);
      expect(consequence.path.barriers.filter(barrier => barrier.credited)).toHaveLength(2);
      expect(consequence.frequencyPerYear).toBeCloseTo(1.3e-11, 22);
    }
    expect(result.consequences.map(consequence => [consequence.consequenceId, consequence.severityBand, consequence.cell.frequencyBand])).toEqual([
      ["environmental-damage-at-river-crossing", 3, 1], ["jet-fire-near-high-consequence-area", 5, 1], ["supply-interruption", 4, 1],
    ]);
    for (const consequence of result.consequences) {
      expect(consequence.cell).toEqual({ frequencyBand: 1, severityBand: consequence.severityBand, rank: consequence.severityBand, zone: consequence.severityBand === 5 ? "amber" : "green" });
    }
    expect(result.cell).toEqual({ frequencyBand: 1, severityBand: 5, rank: 5, zone: "amber" });
    expect(result.worstConsequenceId).toBe("jet-fire-near-high-consequence-area");
    expect(isRiskSnapshot(result)).toBe(true);
  });

  it.each([["degraded", 2.2e-7], ["unverified", 2.2e-7], ["failed", 1.12e-6]] as const)("CP %s increases only the corrosion contribution", (health, expected) => {
    const input = seedInput(BOWTIE_A);
    input.barriers = input.barriers.map(barrier => barrier.id === "cathodic-protection" ? { ...barrier, health } : barrier);
    const result = calculateRisk(input);
    expect(result.topEventFrequencyPerYear).toBeCloseTo(expected, 18);
    for (const consequence of result.consequences) expect(consequence.frequencyPerYear).toBeCloseTo(expected * 1e-4, 22);
  });

  it("is deterministic under seed reordering and does not mutate authored input", () => {
    const input = seedInput(BOWTIE_A);
    const before = structuredClone(input);
    const expected = calculateRisk(input);
    expect(input).toEqual(before);
    input.barriers.reverse(); input.threats.reverse(); input.consequences.reverse(); input.paths.reverse();
    input.paths.forEach(path => path.barrierIds.reverse());
    expect(calculateRisk(input)).toEqual(expected);
  });
});

/** SYNTHETIC/SIMULATION test calibration for PRD B/C, which have no numeric seed yet.
 * Every Threat uses 1/year and every conditional probability 0.1, solely for arithmetic
 * checks. Independence is assumed for these fixtures; no Cross-Domain contribution.
 */
function illustrativeInput(example: "B" | "C"): RiskInput {
  const definitions: { id: string; barriers: [string, "technical" | "organisational" | "human"][] }[] = example === "B" ? [
    { id: "phishing-pivot", barriers: [["segmentation-dmz", "technical"], ["jump-host-mfa", "technical"], ["awareness-training", "human"]] },
    { id: "vendor-access", barriers: [["brokered-time-boxed-access", "organisational"], ["session-recording", "technical"]] },
    { id: "infected-laptop", barriers: [["usb-control-edr", "technical"], ["ot-change-procedure", "organisational"]] },
  ] : [
    { id: "indirect-injection", barriers: [["injection-detector", "technical"], ["retrieved-text-as-data", "technical"], ["tool-allowlist", "technical"]] },
    { id: "restricted-data-paste", barriers: [["classification-routing", "technical"], ["input-dlp", "technical"]] },
    { id: "hallucinated-clause", barriers: [["grounding-check", "technical"], ["citation-requirement", "organisational"], ["human-approval", "human"]] },
    { id: "agent-record-write", barriers: [["tool-call-policy", "technical"]] },
  ];
  const mitigative: [string, "technical" | "organisational" | "human"][] = example === "B" ? [
    ["ot-anomaly-detection", "technical"], ["manual-operation-fallback", "organisational"], ["offline-backups", "technical"],
  ] : [["output-dlp", "technical"], ["approver-review", "human"], ["incident-playbook-key-rotation", "organisational"]];
  const consequences: RiskInput["consequences"] = example === "B" ? [
    { id: "loss-of-view-control", conditionalProbability: 0.1, severity: { serviceContinuity: 4 } },
    { id: "safety-system-impairment", conditionalProbability: 0.1, severity: { people: 5 } },
  ] : [
    { id: "restricted-data-disclosure", conditionalProbability: 0.1, severity: { legalRegulatory: 5 } },
    { id: "wrong-engineering-decision", conditionalProbability: 0.1, severity: { people: 4 } },
  ];
  return {
    bowtieId: `synthetic-test-bowtie-${example}`, matrix: testMatrix(), independenceGroups: [],
    threats: definitions.map(({ id }) => ({ id, frequencyPerYear: 1 })), consequences,
    barriers: [
      ...definitions.flatMap(({ barriers }) => barriers.map(([id, type]) => ({ id, type, side: "preventive" as const, pfdBand: type === "technical" ? 0.01 : 0.1, health: "healthy" as const }))),
      ...mitigative.map(([id, type]) => ({ id, type, side: "mitigative" as const, pfdBand: type === "technical" ? 0.01 : 0.1, health: "healthy" as const })),
    ],
    paths: [
      ...definitions.map(({ id, barriers }) => ({ id: `${id}-path`, side: "preventive" as const, targetId: id, barrierIds: barriers.map(([barrierId]) => barrierId) })),
      ...consequences.map(({ id }) => ({ id: `${id}-path`, side: "mitigative" as const, targetId: id, barrierIds: mitigative.map(([barrierId]) => barrierId) })),
    ],
  };
}

describe("PRD §6.1 B/C illustrative simulation golden", () => {
  it.each([
    ["B", 0.00201, 1e-5, 2.01e-9, "safety-system-impairment"],
    ["C", 0.010201, 1e-4, 1.0201e-7, "restricted-data-disclosure"],
  ] as const)("reproduces Bowtie %s using explicitly simulated calibration", (example, topEventFrequency, mitigativePfd, consequenceFrequency, worstId) => {
    const input = illustrativeInput(example);
    const result = calculateRisk(input);
    expectAuthoredMetadata(input, result, []);
    const preventive = new Map(example === "B" ? [
      ["phishing-pivot", 1e-5], ["vendor-access", 1e-3], ["infected-laptop", 1e-3],
    ] : [
      ["indirect-injection", 1e-6], ["restricted-data-paste", 1e-4], ["hallucinated-clause", 1e-4], ["agent-record-write", 0.01],
    ]);
    for (const threat of result.threats) {
      const expected = preventive.get(threat.threatId);
      if (expected === undefined) throw new Error(`Missing golden ${threat.threatId}`);
      expectBinary64Equal(threat.path.pfd, expected);
      expectBinary64Equal(threat.frequencyPerYear, expected);
    }
    // B: 0.00001 + 0.001 + 0.001; C: 0.000001 + 0.0001 + 0.0001 + 0.01.
    expectBinary64Equal(result.topEventFrequencyPerYear, topEventFrequency);
    for (const consequence of result.consequences) {
      expectBinary64Equal(consequence.path.pfd, mitigativePfd);
      expectBinary64Equal(consequence.frequencyPerYear, consequenceFrequency);
      const severityBand = consequence.consequenceId === worstId ? 5 : 4;
      expect(consequence.severityBand).toBe(severityBand);
      expect(consequence.cell).toEqual({ frequencyBand: 1, severityBand, rank: severityBand, zone: severityBand === 5 ? "amber" : "green" });
    }
    expect(result.cell).toEqual({ frequencyBand: 1, severityBand: 5, rank: 5, zone: "amber" });
    expect(result.worstConsequenceId).toBe(worstId);
    expect(isRiskSnapshot(result)).toBe(true);
  });
});

describe("PRD §6.1 synthetic Bowtie D golden", () => {
  it("reproduces rain, river, tide and degraded generator paths with shared response-team credit", () => {
    const input = seedInput(BOWTIE_D);
    const result = calculateRisk(input);
    expectAuthoredMetadata(input, result, ["traffic-diversion"]);
    // 2×0.00001 + 0.2×0.00001 + 0.5×0.001 + 0.1×(0.1×0.1) = 0.001522.
    expect(result.topEventFrequencyPerYear).toBeCloseTo(0.001522, 15);
    const preventive = new Map([
      ["heavy-convective-rainfall", { pfd: 1e-5, frequency: 2e-5 }],
      ["high-tide-storm-surge", { pfd: 1e-3, frequency: 5e-4 }],
      ["high-upstream-flow", { pfd: 1e-5, frequency: 2e-6 }],
      ["pump-station-outage", { pfd: 1e-2, frequency: 1e-3 }],
    ]);
    for (const threat of result.threats) {
      const golden = preventive.get(threat.threatId);
      if (!golden) throw new Error(`Missing golden ${threat.threatId}`);
      expectBinary64Equal(threat.path.pfd, golden.pfd);
      expectBinary64Equal(threat.frequencyPerYear, golden.frequency);
    }
    const expected = new Map([
      ["electrocution-drowning", { pfd: 1e-5, frequency: 1.522e-9, severity: 5 }],
      ["hospital-emergency-access", { pfd: 1e-2, frequency: 1.522e-6, severity: 5 }],
      ["metro-road-disruption", { pfd: 1e-2, frequency: 1.522e-6, severity: 4 }],
      ["property-economic-loss", { pfd: 1e-4, frequency: 1.522e-8, severity: 4 }],
    ]);
    for (const consequence of result.consequences) {
      const golden = expected.get(consequence.consequenceId);
      if (!golden) throw new Error(`Missing golden ${consequence.consequenceId}`);
      expectBinary64Equal(consequence.path.pfd, golden.pfd);
      expect(consequence.frequencyPerYear).toBeCloseTo(golden.frequency, 20);
      expect(consequence.cell.frequencyBand).toBe(1);
      expect(consequence.severityBand).toBe(golden.severity);
      expect(consequence.cell).toEqual({ frequencyBand: 1, severityBand: golden.severity, rank: golden.severity, zone: golden.severity === 5 ? "amber" : "green" });
    }
    expect(result.worstConsequenceId).toBe("electrocution-drowning");
    expect(result.cell).toEqual({ frequencyBand: 1, severityBand: 5, rank: 5, zone: "amber" });
    expect(isRiskSnapshot(result)).toBe(true);
  });
});
