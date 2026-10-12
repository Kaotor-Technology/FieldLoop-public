import {
  riskInputErrors,
  type BarrierHealth, type RiskBarrier, type RiskBand, type RiskCell,
  type RiskInput, type RiskMatrix, type RiskPath, type RiskPathResult,
  type RiskSnapshot,
} from "@fieldloop/contracts";

export class RiskInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RiskInputError";
  }
}

const ZONE_ORDER = { green: 0, amber: 1, red: 2 } as const;

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function indexById<T extends { id: string }>(items: readonly T[], label: string): Map<string, T> {
  const index = new Map<string, T>();
  for (const item of items) {
    if (index.has(item.id)) throw new RiskInputError(`Duplicate ${label} ${item.id}`);
    index.set(item.id, item);
  }
  return index;
}

function healthForCalculation(barrier: RiskBarrier): BarrierHealth {
  if (barrier.evidenceExpired && (barrier.health === "healthy" || barrier.health === "degraded")) return "unverified";
  return barrier.health;
}

function effectivePfd(barrier: RiskBarrier): number {
  const ceiling = barrier.type === "technical" ? 0.01 : 0.1;
  if (barrier.pfdBand < ceiling && !(barrier.type === "technical" && barrier.certified === true)) {
    throw new RiskInputError(`Barrier ${barrier.id} PFD ${barrier.pfdBand} is better than its uncertified ${barrier.type} ceiling ${ceiling}`);
  }
  const health = healthForCalculation(barrier);
  if (health === "failed") return 1;
  return health === "healthy" ? barrier.pfdBand : Math.min(1, barrier.pfdBand * 10);
}

/** Refuse a false zero or Infinity instead of under-reporting frequency. */
function multiply(left: number, right: number, label: string): number {
  const value = left * right;
  if (!Number.isFinite(value) || (value === 0 && left > 0 && right > 0)) {
    throw new RiskInputError(`Numeric overflow or underflow in ${label}`);
  }
  return value;
}

function pathResult(path: RiskPath, barriers: Map<string, RiskBarrier>): RiskPathResult {
  const members = path.barrierIds.map(id => {
    const barrier = barriers.get(id);
    if (!barrier) throw new RiskInputError(`Path ${path.id} references missing Barrier ${id}`);
    if (barrier.side !== path.side) throw new RiskInputError(`Barrier ${id} is on the wrong side of path ${path.id}`);
    return barrier;
  }).sort(byId);
  const strongest = new Map<string, { id: string; pfd: number }>();
  for (const barrier of members) {
    const groupId = barrier.independenceGroupId;
    if (groupId === undefined) continue;
    const pfd = effectivePfd(barrier);
    const current = strongest.get(groupId);
    // Sorted IDs break equal-PFD ties without depending on input order.
    if (!current || pfd < current.pfd) strongest.set(groupId, { id: barrier.id, pfd });
  }
  let pfd = 1;
  const credits = members.map(barrier => {
    const value = effectivePfd(barrier);
    const credited = barrier.independenceGroupId === undefined || strongest.get(barrier.independenceGroupId)?.id === barrier.id;
    if (credited) pfd = multiply(pfd, value, `path ${path.id}`);
    return { barrierId: barrier.id, health: healthForCalculation(barrier), effectivePfd: value, credited };
  });
  return { pathId: path.id, targetId: path.targetId, pfd, barriers: credits };
}

function matrixCell(matrix: RiskMatrix, frequencyBand: RiskBand, severityBand: RiskBand): RiskCell {
  const cell = matrix.cells[frequencyBand - 1]?.[severityBand - 1];
  if (!cell) throw new RiskInputError(`Missing Risk Matrix cell ${frequencyBand}/${severityBand}`);
  return { ...cell, frequencyBand, severityBand };
}

function validateMatrix(matrix: RiskMatrix): void {
  for (let index = 1; index < matrix.frequencyThresholds.length; index++) {
    const previous = matrix.frequencyThresholds[index - 1];
    const current = matrix.frequencyThresholds[index];
    if (previous === undefined || current === undefined || current <= previous) {
      throw new RiskInputError("Risk Matrix frequency thresholds must be strictly increasing");
    }
  }
  for (let row = 0; row < 5; row++) {
    for (let column = 0; column < 5; column++) {
      const cell = matrix.cells[row]?.[column];
      if (!cell) throw new RiskInputError(`Missing Risk Matrix cell ${row + 1}/${column + 1}`);
      for (const previous of [matrix.cells[row - 1]?.[column], matrix.cells[row]?.[column - 1]]) {
        if (previous && (ZONE_ORDER[cell.zone] < ZONE_ORDER[previous.zone] ||
          (cell.zone === previous.zone && cell.rank < previous.rank))) {
          throw new RiskInputError(`Risk Matrix cell ${row + 1}/${column + 1} improves as frequency or severity increases`);
        }
      }
    }
  }
}

function compareCells(a: RiskCell, b: RiskCell): number {
  return ZONE_ORDER[a.zone] - ZONE_ORDER[b.zone] || a.rank - b.rank ||
    a.severityBand - b.severityBand || a.frequencyBand - b.frequencyBand;
}

/** AS-3–AS-9. All input is validated before a result is returned; no I/O or stored Health changes. */
export function calculateRisk(input: RiskInput): RiskSnapshot {
  const errors = riskInputErrors(input);
  if (errors.length > 0) {
    throw new RiskInputError(errors.map(error => {
      const barrierIndex = /^\/barriers\/(\d+)/.exec(error.path)?.[1];
      const barrierId = barrierIndex === undefined ? undefined : input?.barriers?.[Number(barrierIndex)]?.id;
      return `${barrierId === undefined ? "Risk input" : `Barrier ${barrierId}`} at ${error.path || "/"}: ${error.message}`;
    }).join("; "));
  }
  validateMatrix(input.matrix);
  const barriers = indexById(input.barriers, "Barrier");
  const threatsById = indexById(input.threats, "Threat");
  const consequencesById = indexById(input.consequences, "Consequence");
  const groups = indexById(input.independenceGroups, "Independence Group");
  indexById(input.paths, "path");
  for (const barrier of barriers.values()) {
    effectivePfd(barrier);
    if (barrier.independenceGroupId !== undefined && !groups.has(barrier.independenceGroupId)) {
      throw new RiskInputError(`Barrier ${barrier.id} references missing Independence Group ${barrier.independenceGroupId}`);
    }
  }
  const preventive = new Map<string, RiskPathResult>();
  const mitigative = new Map<string, RiskPathResult>();
  for (const path of input.paths) {
    const targets = path.side === "preventive" ? threatsById : consequencesById;
    const results = path.side === "preventive" ? preventive : mitigative;
    if (!targets.has(path.targetId)) throw new RiskInputError(`Orphan path ${path.id}: unknown ${path.side} target ${path.targetId}`);
    if (results.has(path.targetId)) throw new RiskInputError(`Multiple ${path.side} paths for ${path.targetId}; correlation is unspecified`);
    results.set(path.targetId, pathResult(path, barriers));
  }
  let topEventFrequencyPerYear = 0;
  const threats = [...input.threats].sort(byId).map(threat => {
    const path = preventive.get(threat.id);
    if (!path) throw new RiskInputError(`Threat ${threat.id} has no explicit preventive path`);
    const frequencyPerYear = multiply(threat.frequencyPerYear, path.pfd, `Threat ${threat.id}`);
    topEventFrequencyPerYear += frequencyPerYear;
    if (!Number.isFinite(topEventFrequencyPerYear)) throw new RiskInputError("Top Event frequency overflow");
    return { threatId: threat.id, frequencyPerYear, path };
  });
  const consequences = [...input.consequences].sort(byId).map(consequence => {
    const path = mitigative.get(consequence.id);
    if (!path) throw new RiskInputError(`Consequence ${consequence.id} has no explicit mitigative path`);
    const frequencyPerYear = multiply(multiply(topEventFrequencyPerYear, consequence.conditionalProbability, `Consequence ${consequence.id}`), path.pfd, `Consequence ${consequence.id}`);
    const severityBand = Math.max(...Object.values(consequence.severity)) as RiskBand;
    const frequencyBand = (1 + input.matrix.frequencyThresholds.filter(threshold => frequencyPerYear >= threshold).length) as RiskBand;
    return { consequenceId: consequence.id, frequencyPerYear, severityBand, path, cell: matrixCell(input.matrix, frequencyBand, severityBand) };
  });
  let worst = consequences[0];
  if (!worst) throw new RiskInputError("Bowtie requires a Consequence");
  for (const consequence of consequences) {
    if (compareCells(consequence.cell, worst.cell) > 0) worst = consequence;
  }
  return { bowtieId: input.bowtieId, topEventFrequencyPerYear, threats, consequences, worstConsequenceId: worst.consequenceId, cell: { ...worst.cell } };
}
