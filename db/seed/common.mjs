import { createHash } from "node:crypto";

const UUID_NAMESPACE_URL = Buffer.from(
  "6ba7b8119dad11d180b400c04fd430c8",
  "hex",
);
const CLASSIFICATIONS = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED"];

export function requireClassification(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`${fieldName} requires classification.`);
  }
  if (!CLASSIFICATIONS.includes(value)) {
    throw new Error(`${fieldName} classification must be one of ${CLASSIFICATIONS.join(", ")}.`);
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireSeedString(value, fieldName, seedName = "Bowtie A") {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${seedName} seed requires ${fieldName}.`);
  }
}

export function validateBowtieSeed(seed, seedName = "Bowtie A") {
  const requireString = (value, fieldName) => requireSeedString(value, fieldName, seedName);
  if (!isRecord(seed)) {
    throw new Error(`${seedName} seed must be a JSON object.`);
  }
  for (const fieldName of ["id", "assetCode", "hazard", "topEvent", "domain", "status", "version"]) {
    requireString(seed[fieldName], fieldName);
  }
  if (!isRecord(seed.metadata)) {
    throw new Error(`${seedName} seed requires metadata.`);
  }
  if (seed.metadata.label !== "SYNTHETIC" || seed.metadata.simulated !== true) {
    throw new Error(`${seedName} seed metadata must label the data SYNTHETIC and simulated.`);
  }
  requireString(seed.metadata.classification, "metadata.classification");
  requireClassification(seed.metadata.classification, `${seedName} seed metadata`);
  requireString(seed.metadata.parameterBasis, "metadata.parameterBasis");
  if (!Number.isFinite(Date.parse(seed.metadata.simulationStartsAt))) {
    throw new Error(`${seedName} seed requires a valid metadata.simulationStartsAt.`);
  }
  for (const fieldName of ["threats", "consequences", "barriers", "independenceGroups", "paths"]) {
    if (!Array.isArray(seed[fieldName]) || seed[fieldName].length === 0) {
      throw new Error(`${seedName} seed requires a non-empty ${fieldName} array.`);
    }
  }

  const entities = [
    ...seed.threats.map((item) => ["Threat", item]),
    ...seed.consequences.map((item) => ["Consequence", item]),
    ...seed.barriers.map((item) => ["Barrier", item]),
    ...seed.independenceGroups.map((item) => ["Independence Group", item]),
  ];
  const entityIds = new Set();
  for (const [entityName, entity] of entities) {
    if (!isRecord(entity)) {
      throw new Error(`${seedName} seed contains an invalid ${entityName}.`);
    }
    requireString(entity.id, `${entityName}.id`);
    if (entityIds.has(entity.id)) {
      throw new Error(`${seedName} seed repeats entity ID ${entity.id}.`);
    }
    entityIds.add(entity.id);
  }

  const threatIds = new Set(seed.threats.map((threat) => threat.id));
  const consequenceIds = new Set(seed.consequences.map((consequence) => consequence.id));
  const barriersById = new Map(seed.barriers.map((barrier) => [barrier.id, barrier]));
  const groupsById = new Map(seed.independenceGroups.map((group) => [group.id, group]));
  const preventiveTargets = new Set();
  const mitigativeTargets = new Set();
  const barrierUsage = new Set();
  const pathIds = new Set();

  for (const threat of seed.threats) {
    requireString(threat.name, `Threat ${threat.id}.name`);
    if (!Number.isFinite(threat.frequencyPerYear) || threat.frequencyPerYear <= 0) {
      throw new Error(`Threat ${threat.id} requires a positive simulated frequencyPerYear.`);
    }
  }
  for (const consequence of seed.consequences) {
    requireString(consequence.name, `Consequence ${consequence.id}.name`);
    if (!isRecord(consequence.severity) || Object.keys(consequence.severity).length === 0) {
      throw new Error(`Consequence ${consequence.id} requires a severity dimension.`);
    }
    if (Object.values(consequence.severity).some((band) => !Number.isInteger(band) || band < 1 || band > 5)) {
      throw new Error(`Consequence ${consequence.id} has a severity band outside 1–5.`);
    }
    if (!Number.isFinite(consequence.conditionalProbability) || consequence.conditionalProbability < 0 || consequence.conditionalProbability > 1) {
      throw new Error(`Consequence ${consequence.id} requires a conditional probability from 0 to 1.`);
    }
  }
  for (const barrier of seed.barriers) {
    requireString(barrier.name, `Barrier ${barrier.id}.name`);
    requireString(barrier.performanceStandard, `Barrier ${barrier.id}.performanceStandard`);
    requireString(barrier.evidenceInterval, `Barrier ${barrier.id}.evidenceInterval`);
    if (!["technical", "organisational", "human"].includes(barrier.type)) {
      throw new Error(`Barrier ${barrier.id} has an invalid type.`);
    }
    if (!["preventive", "mitigative"].includes(barrier.side)) {
      throw new Error(`Barrier ${barrier.id} has an invalid side.`);
    }
    const minimumPfd = barrier.type === "technical" ? 0.01 : 0.1;
    if (!Number.isFinite(barrier.pfdBand) || barrier.pfdBand < minimumPfd || barrier.pfdBand > 1) {
      throw new Error(`Barrier ${barrier.id} violates the PRD AS-4 PFD ceiling for ${barrier.type}.`);
    }
    if (!["healthy", "degraded", "failed", "unverified"].includes(barrier.health)) {
      throw new Error(`Barrier ${barrier.id} has an invalid Health value.`);
    }
    if (!isRecord(barrier.triad)) {
      throw new Error(`Barrier ${barrier.id} requires the Validation Triad.`);
    }
    for (const checkName of ["effective", "independent", "auditable"]) {
      const check = barrier.triad[checkName];
      if (!isRecord(check) || check.pass !== true) {
        throw new Error(`Barrier ${barrier.id} must pass the ${checkName} Validation Triad check.`);
      }
      requireString(check.justification, `Barrier ${barrier.id} ${checkName} justification`);
    }
    if (!Array.isArray(barrier.evidence) || barrier.evidence.length < 2) {
      throw new Error(`Barrier ${barrier.id} requires an Evidence history of at least two records.`);
    }
    for (const evidence of barrier.evidence) {
      requireString(evidence.id, `Barrier ${barrier.id} Evidence.id`);
      requireString(evidence.kind, `Evidence ${evidence.id}.kind`);
      requireString(evidence.source, `Evidence ${evidence.id}.source`);
      if (!Number.isFinite(Date.parse(evidence.observedAt))) {
        throw new Error(`Evidence ${evidence.id} requires a valid observedAt timestamp.`);
      }
    }
    if (barrier.independenceGroupId && !groupsById.has(barrier.independenceGroupId)) {
      throw new Error(`Barrier ${barrier.id} references an unknown Independence Group.`);
    }
    for (const factor of barrier.degradationFactors ?? []) {
      requireString(factor.id, `Barrier ${barrier.id} DegradationFactor.id`);
      requireString(factor.description, `Degradation Factor ${factor.id}.description`);
      if (!Array.isArray(factor.controls) || factor.controls.length === 0) {
        throw new Error(`Degradation Factor ${factor.id} requires a Degradation Control.`);
      }
      for (const control of factor.controls) {
        requireString(control.id, `Degradation Factor ${factor.id} control.id`);
        requireString(control.description, `Degradation Control ${control.id}.description`);
      }
    }
  }
  for (const group of seed.independenceGroups) {
    requireString(group.cause, `Independence Group ${group.id}.cause`);
    const members = seed.barriers.filter((barrier) => barrier.independenceGroupId === group.id);
    if (members.length < 2) {
      throw new Error(`Independence Group ${group.id} must contain at least two Barriers.`);
    }
  }

  for (const path of seed.paths) {
    requireString(path.id, "path.id");
    if (pathIds.has(path.id)) {
      throw new Error(`${seedName} seed repeats path ID ${path.id}.`);
    }
    pathIds.add(path.id);
    const validTarget = path.side === "preventive"
      ? threatIds.has(path.targetId)
      : path.side === "mitigative" && consequenceIds.has(path.targetId);
    if (!validTarget) {
      throw new Error(`Path ${path.id} does not target a ${path.side === "preventive" ? "Threat" : "Consequence"}.`);
    }
    if (!Array.isArray(path.barrierIds) || path.barrierIds.length === 0) {
      throw new Error(`Path ${path.id} requires at least one Barrier.`);
    }
    const targetSet = path.side === "preventive" ? preventiveTargets : mitigativeTargets;
    targetSet.add(path.targetId);
    for (const barrierId of path.barrierIds) {
      const barrier = barriersById.get(barrierId);
      if (!barrier || barrier.side !== path.side) {
        throw new Error(`Path ${path.id} references a missing or wrong-side Barrier ${barrierId}.`);
      }
      if (path.barrierIds.indexOf(barrierId) !== path.barrierIds.lastIndexOf(barrierId)) {
        throw new Error(`Path ${path.id} repeats Barrier ${barrierId}.`);
      }
      barrierUsage.add(barrierId);
    }
  }
  if (seed.threats.some((threat) => !preventiveTargets.has(threat.id))) {
    throw new Error("Every Threat must have a Preventive path to the Top Event.");
  }
  if (seed.consequences.some((consequence) => !mitigativeTargets.has(consequence.id))) {
    throw new Error("Every Consequence must have a Mitigative path from the Top Event.");
  }
  if (seed.barriers.some((barrier) => !barrierUsage.has(barrier.id))) {
    throw new Error("Every Barrier must be used by at least one Bowtie path.");
  }
  return seed;
}

export function deterministicUuid(name) {
  const bytes = Buffer.from(
    createHash("sha1")
      .update(UUID_NAMESPACE_URL)
      .update(name, "utf8")
      .digest()
      .subarray(0, 16),
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}


// dbmate and Cloud SQL name a Unix socket directory with an empty host and ?socket= or ?host=.
// The WHATWG URL parser rejects an empty host, and the driver rejects one followed by a port, so
// the URL is read and passed on with a placeholder host. The driver connects to ?host= instead.
const EMPTY_HOST = "localhost";

// Returns FIELDLOOP_DATABASE_URL in the form the PostgreSQL driver reads.
export function driverConnectionString(connectionString) {
  if (!/^postgres(ql)?:\/\//.test(connectionString)) {
    throw new Error("FIELDLOOP_DATABASE_URL must use postgres:// or postgresql://.");
  }
  const withHost = connectionString.replace(/^([a-z]+:\/\/(?:[^/?#@]*@)?)(?=\/|:\d+\/)/, "$1" + EMPTY_HOST);
  const hostWasEmpty = withHost !== connectionString;
  let url;
  try {
    url = new URL(withHost);
  } catch {
    throw new Error("FIELDLOOP_DATABASE_URL must be a valid PostgreSQL URL.");
  }
  const socket = url.searchParams.get("socket");
  if (socket !== null) {
    url.searchParams.delete("socket");
    if (!url.searchParams.has("host")) {
      url.searchParams.set("host", socket);
    }
  }
  // dbmate reads the same URL and gives sslmode=require its libpq meaning: encrypt, without checking
  // the server certificate. The driver does that only when asked. Other modes are left as they are.
  if (url.searchParams.get("sslmode") === "require" && !url.searchParams.has("uselibpqcompat")) {
    url.searchParams.set("uselibpqcompat", "true");
  }
  const hasHost = Boolean(url.searchParams.get("host")) || !hostWasEmpty;
  if (!url.pathname.replace(/^\/+/, "") || !hasHost || !url.username) {
    throw new Error(
      "FIELDLOOP_DATABASE_URL must include a host, database name and user.",
    );
  }
  return url.toString();
}
