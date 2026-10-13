export type BarrierHealth = "healthy" | "degraded" | "failed" | "unverified";
export type RiskZone = "intolerable" | "alarp" | "acceptable";

export interface RiskBarrier {
  id: string;
  side: "preventive" | "mitigative";
  pfd: number | null;
  health: BarrierHealth | null;
  independenceGroupId: string | null;
}

export interface RiskPath {
  targetType: "threat" | "consequence";
  targetId: string;
  barrierId: string;
  position: number;
}

export interface RiskThreat {
  id: string;
  frequencyPerYear: number;
}

export interface RiskConsequence {
  id: string;
  conditionalProbability: number;
  severityBands: readonly number[];
}

export interface RiskScoreInput {
  threats: readonly RiskThreat[];
  consequences: readonly RiskConsequence[];
  barriers: readonly RiskBarrier[];
  paths: readonly RiskPath[];
}

export interface ConsequenceRiskCell {
  consequenceId: string;
  frequencyPerYear: number;
  frequencyBand: number;
  severityBand: number;
  zone: RiskZone;
}

export interface RiskScore {
  topEventFrequencyPerYear: number;
  cells: readonly ConsequenceRiskCell[];
  worstZone: RiskZone | null;
}

// Demo default cell assignment: likelihood band is the row, severity band the column.
// This table is deliberately explicit so a later Organisation RiskMatrix config can replace it.
const DEFAULT_DEMO_RISK_MATRIX: readonly (readonly RiskZone[])[] = [
  ["acceptable", "acceptable", "acceptable", "acceptable", "alarp"],
  ["acceptable", "acceptable", "alarp", "alarp", "alarp"],
  ["acceptable", "alarp", "alarp", "intolerable", "intolerable"],
  ["acceptable", "alarp", "alarp", "alarp", "intolerable"],
  ["alarp", "alarp", "alarp", "intolerable", "intolerable"],
];

const ZONE_SEVERITY: Record<RiskZone, number> = { acceptable: 0, alarp: 1, intolerable: 2 };

/** Calculates the AS-3…AS-9 Risk Score slice needed by the demo map. */
export function calculateRiskScore(input: RiskScoreInput): RiskScore {
  validateInput(input);
  const barriers = new Map(input.barriers.map((barrier) => [barrier.id, barrier]));
  const preventiveByThreat = pathsByTarget(input.paths, "threat");
  const mitigativeByConsequence = pathsByTarget(input.paths, "consequence");
  const topEventFrequencyPerYear = input.threats.reduce((total, threat) => total +
    threat.frequencyPerYear * pathFailureProbability(preventiveByThreat.get(threat.id) ?? [], barriers), 0);

  const cells = input.consequences.map((consequence) => {
    const frequencyPerYear = topEventFrequencyPerYear * consequence.conditionalProbability *
      pathFailureProbability(mitigativeByConsequence.get(consequence.id) ?? [], barriers);
    const frequencyBand = frequencyBandFor(frequencyPerYear);
    const severityBand = Math.max(...consequence.severityBands);
    return {
      consequenceId: consequence.id,
      frequencyPerYear,
      frequencyBand,
      severityBand,
      zone: DEFAULT_DEMO_RISK_MATRIX[frequencyBand - 1]?.[severityBand - 1] ?? "intolerable",
    } satisfies ConsequenceRiskCell;
  });
  const worstZone = cells.reduce<RiskZone | null>((worst, cell) =>
    worst === null || ZONE_SEVERITY[cell.zone] > ZONE_SEVERITY[worst] ? cell.zone : worst, null);
  return { topEventFrequencyPerYear, cells, worstZone };
}

function pathsByTarget(paths: readonly RiskPath[], targetType: RiskPath["targetType"]): Map<string, RiskPath[]> {
  const grouped = new Map<string, RiskPath[]>();
  for (const path of paths) {
    if (path.targetType !== targetType) continue;
    const targetPaths = grouped.get(path.targetId) ?? [];
    targetPaths.push(path);
    grouped.set(path.targetId, targetPaths);
  }
  return grouped;
}

function pathFailureProbability(paths: readonly RiskPath[], barriers: ReadonlyMap<string, RiskBarrier>): number {
  const groups = new Map<string, number[]>();
  for (const path of [...paths].sort((left, right) => left.position - right.position)) {
    const barrier = barriers.get(path.barrierId);
    if (!barrier) continue;
    const pfd = effectivePfd(barrier);
    const groupKey = barrier.independenceGroupId ? `group:${barrier.independenceGroupId}` : `barrier:${barrier.id}`;
    const members = groups.get(groupKey) ?? [];
    members.push(pfd);
    groups.set(groupKey, members);
  }
  return [...groups.values()].reduce((product, members) => product * Math.min(...members), 1);
}

function effectivePfd(barrier: RiskBarrier): number {
  const pfd = barrier.pfd ?? 1;
  if (barrier.health === null || barrier.health === "failed") return 1;
  if (barrier.health === "degraded" || barrier.health === "unverified") return Math.min(1, pfd * 10);
  return pfd;
}

function frequencyBandFor(frequencyPerYear: number): number {
  if (frequencyPerYear < 1e-5) return 1;
  if (frequencyPerYear < 1e-4) return 2;
  if (frequencyPerYear < 1e-3) return 3;
  if (frequencyPerYear < 1e-2) return 4;
  return 5;
}

function validateInput(input: RiskScoreInput): void {
  for (const threat of input.threats) {
    if (!Number.isFinite(threat.frequencyPerYear) || threat.frequencyPerYear < 0) {
      throw new Error(`Threat ${threat.id} must have a finite non-negative frequency.`);
    }
  }
  for (const consequence of input.consequences) {
    if (!Number.isFinite(consequence.conditionalProbability) || consequence.conditionalProbability < 0 || consequence.conditionalProbability > 1) {
      throw new Error(`Consequence ${consequence.id} must have a probability between 0 and 1.`);
    }
    if (!consequence.severityBands.length || consequence.severityBands.some((band) => !Number.isInteger(band) || band < 1 || band > 5)) {
      throw new Error(`Consequence ${consequence.id} must have severity bands from 1 through 5.`);
    }
  }
  const barrierIds = new Set<string>();
  for (const barrier of input.barriers) {
    if (barrierIds.has(barrier.id)) throw new Error(`Barrier ${barrier.id} must be unique in a Risk Score input.`);
    barrierIds.add(barrier.id);
    if (barrier.pfd !== null && (!Number.isFinite(barrier.pfd) || barrier.pfd < 0 || barrier.pfd > 1)) {
      throw new Error(`Barrier ${barrier.id} must have a PFD between 0 and 1.`);
    }
  }
  for (const path of input.paths) {
    if (!Number.isInteger(path.position) || path.position < 1) throw new Error("Barrier path position must be a positive integer.");
    const barrier = input.barriers.find((item) => item.id === path.barrierId);
    if (!barrier) throw new Error(`Barrier path ${path.barrierId} references a missing Barrier.`);
    const expectedSide = path.targetType === "threat" ? "preventive" : "mitigative";
    if (barrier.side !== expectedSide) throw new Error(`Barrier ${barrier.id} is on the wrong side of its path.`);
  }
}
