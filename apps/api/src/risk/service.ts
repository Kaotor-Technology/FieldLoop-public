import { calculateRisk, RiskInputError } from "@fieldloop/domain/risk";
import { riskInputErrors, type RiskInput, type RiskSnapshot, type RiskMatrix } from "@fieldloop/contracts";
import type { Pool } from "pg";
import type { CurrentUser } from "../auth/service.js";

const CLASSIFICATIONS = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED"] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class RiskServiceError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export interface RiskSnapshotEnvelope {
  id: string;
  createdAt: string;
  trigger: string;
  snapshot: RiskSnapshot;
}

export interface BowtieSummary {
  id: string;
  hazard: string;
  topEvent: string;
  domain: string | null;
  status: string | null;
  simulated: boolean;
  classification: string;
}

export interface BowtieCanvas extends BowtieSummary {
  severityCriteria: SeverityCriteria | null;
  threats: { id: string; name: string; frequencyPerYear: number }[];
  barriers: { id: string; name: string; type: string; side: string; health: string; pfdBand: number; degradationFactors: string[] }[];
  consequences: { id: string; name: string; severity: Record<string, number> }[];
  paths: { id: string; side: string; targetId: string; barrierIds: string[] }[];
}

export interface SeverityCriteria {
  people: string[];
  environment: string[];
  financial: string[];
  serviceContinuity: string[];
  reputation: string[];
  legalRegulatory: string[];
}

export interface RiskChange {
  barrierId: string;
  beforeHealth: string;
  afterHealth: string;
  reason: string;
  sourceEvidenceId: string | null;
  sourceEvidenceHref: string | null;
  topEventFrequencyDeltaPerYear: number;
  consequenceFrequencyDeltasPerYear: { consequenceId: string; delta: number }[];
  impact: number;
}

export interface RiskExplain {
  bowtieId: string;
  hasPrevious: boolean;
  summary: string;
  previous: RiskSnapshotEnvelope | null;
  current: RiskSnapshotEnvelope;
  changes: RiskChange[];
}

export interface EvidenceSummary {
  id: string;
  barrierId: string;
  kind: string;
  source: string;
  observedAt: string;
  simulated: boolean;
  classification: string;
}

export interface RiskEvent {
  id: string;
  createdAt: string;
  bowtieId: string;
  snapshotId: string;
  trigger: string;
  snapshot: RiskSnapshot;
}

interface HealthChangeCursor {
  id: string;
  barrierId: string;
  createdAt: Date | string;
  fromHealth: string | null;
  toHealth: string;
}

export interface RiskApiPort {
  listBowties(user: CurrentUser): Promise<BowtieSummary[]>;
  getBowtie(user: CurrentUser, bowtieId: string): Promise<BowtieCanvas>;
  getRisk(user: CurrentUser, bowtieId: string): Promise<RiskSnapshotEnvelope>;
  explain(user: CurrentUser, bowtieId: string): Promise<RiskExplain>;
  getEvidence(user: CurrentUser, evidenceId: string): Promise<EvidenceSummary>;
  riskEventsAfter(user: CurrentUser, cursor: { createdAt: string; id: string } | null): Promise<RiskEvent[]>;
  processHealthChanges(): Promise<number>;
}

interface StoredInput {
  input: RiskInput;
  evidenceByBarrier: Record<string, string | null>;
}

interface BowtieRow {
  id: string;
  hazard: string;
  top_event: string;
  domain: string | null;
  status: string | null;
  simulated: boolean;
  classification: string;
}

interface LoadedRisk {
  bowtie: BowtieRow;
  stored: StoredInput;
  classification: string;
}

export class PostgresRiskService implements RiskApiPort {
  constructor(private readonly pool: Pool) {}

  async listBowties(user: CurrentUser): Promise<BowtieSummary[]> {
    const rows = await this.pool.query<BowtieRow>(
      `SELECT id, hazard, top_event, domain, status, simulated, classification
       FROM app.bowtie WHERE org_id = $1 ORDER BY id`, [user.orgId],
    );
    return rows.rows.map((row) => {
      assertClearance(user, row.classification);
      return summary(row);
    });
  }

  async getBowtie(user: CurrentUser, bowtieId: string): Promise<BowtieCanvas> {
    if (!UUID_PATTERN.test(bowtieId)) throw new RiskServiceError(400, "validation_failed");
    const bowtieResult = await this.pool.query<BowtieRow>(
      `SELECT id, hazard, top_event, domain, status, simulated, classification
       FROM app.bowtie WHERE org_id = $1 AND id = $2`, [user.orgId, bowtieId],
    );
    const bowtie = bowtieResult.rows[0];
    if (!bowtie) throw new RiskServiceError(404, "not_found");
    assertClearance(user, bowtie.classification);
    const { rows: organisationRows } = await this.pool.query(
      `SELECT risk_matrix, risk_severity_criteria, risk_matrix_approved_at, risk_matrix_approved_by, classification
       FROM app.organisation WHERE org_id = $1 ORDER BY id LIMIT 1`, [user.orgId],
    );
    const organisation = organisationRows[0];
    if (organisation) assertClearance(user, organisation.classification);
    const severityCriteria = organisation?.risk_matrix && organisation.risk_matrix_approved_at && organisation.risk_matrix_approved_by
      && isSeverityCriteria(organisation.risk_severity_criteria)
      ? organisation.risk_severity_criteria as SeverityCriteria : null;
    const { rows: threats } = await this.pool.query(
      `SELECT id, name, frequency_per_year, classification FROM app.threat
       WHERE org_id = $1 AND bowtie_id = $2 ORDER BY id`, [user.orgId, bowtieId],
    );
    const { rows: consequences } = await this.pool.query(
      `SELECT id, name, severity, classification FROM app.consequence
       WHERE org_id = $1 AND bowtie_id = $2 ORDER BY id`, [user.orgId, bowtieId],
    );
    const { rows: barriers } = await this.pool.query(
      `SELECT DISTINCT b.id, b.name, b.type, b.side, b.health, b.pfd_band,
              b.classification,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('description', df.description, 'classification', df.classification) ORDER BY df.id)
                        FROM app.degradation_factor df WHERE df.org_id = b.org_id AND df.barrier_id = b.id), '[]'::jsonb) AS factors
       FROM app.barrier_path bp JOIN app.barrier b ON b.id = bp.barrier_id AND b.org_id = bp.org_id
       WHERE bp.org_id = $1 AND ((bp.threat_id IN (SELECT id FROM app.threat WHERE org_id = $1 AND bowtie_id = $2))
          OR (bp.consequence_id IN (SELECT id FROM app.consequence WHERE org_id = $1 AND bowtie_id = $2)))
       ORDER BY b.id`, [user.orgId, bowtieId],
    );
    const { rows: pathRows } = await this.pool.query(
      `SELECT bp.id, bp.position, bp.threat_id, bp.consequence_id, bp.classification AS path_classification,
              b.id AS barrier_id, b.side AS barrier_side, b.classification AS barrier_classification
       FROM app.barrier_path bp JOIN app.barrier b ON b.id = bp.barrier_id AND b.org_id = bp.org_id
       WHERE bp.org_id = $1 AND ((bp.threat_id IN (SELECT id FROM app.threat WHERE org_id = $1 AND bowtie_id = $2))
          OR (bp.consequence_id IN (SELECT id FROM app.consequence WHERE org_id = $1 AND bowtie_id = $2)))
       ORDER BY bp.position, bp.id`, [user.orgId, bowtieId],
    );
    for (const row of [...threats, ...consequences, ...barriers, ...pathRows]) assertClearance(user, row.classification ?? row.path_classification ?? row.barrier_classification);
    const factorsByBarrier = new Map<string, string[]>();
    for (const barrier of barriers) {
      const factors = barrier.factors as { description: string; classification: string }[];
      factorsByBarrier.set(String(barrier.id), factors.map((factor) => {
        assertClearance(user, factor.classification);
        return String(factor.description);
      }));
    }
    const grouped = new Map<string, { id: string; side: string; targetId: string; barrierIds: string[] }>();
    for (const row of pathRows) {
      const side = row.threat_id ? "preventive" : "mitigative";
      const targetId = String(row.threat_id ?? row.consequence_id);
      const key = `${side}:${targetId}`;
      const path = grouped.get(key) ?? { id: key, side, targetId, barrierIds: [] };
      path.barrierIds.push(String(row.barrier_id)); grouped.set(key, path);
    }
    return {
      ...summary(bowtie),
      severityCriteria,
      threats: threats.map((row) => ({ id: row.id, name: row.name ?? row.id, frequencyPerYear: numberValue(row.frequency_per_year) })),
      barriers: barriers.map((row) => ({
        id: row.id, name: row.name ?? row.id, type: row.type, side: row.side, health: row.health,
        pfdBand: numberValue(row.pfd_band), degradationFactors: factorsByBarrier.get(String(row.id)) ?? [],
      })),
      consequences: consequences.map((row) => ({ id: row.id, name: row.name ?? row.id, severity: normalizeSeverity(row.severity) })),
      paths: [...grouped.values()],
    };
  }

  async getRisk(user: CurrentUser, bowtieId: string): Promise<RiskSnapshotEnvelope> {
    const loaded = await this.loadRisk(user, bowtieId);
    const snapshot = calculateConfiguredRisk(loaded.stored.input);
    const current = await this.latestSnapshot(user.orgId, bowtieId);
    if (current) assertClearance(user, current.classification);
    const sameSnapshot = current && canonicalJson(current.snapshot_json) === canonicalJson(snapshot)
      && canonicalJson(current.input_json) === canonicalJson(loaded.stored);
    if (sameSnapshot) return snapshotEnvelope(current);
    const saved = await this.saveSnapshot({
      user, loaded, snapshot, trigger: current ? "recalculated" : "initial", healthChangeId: null,
    });
    return snapshotEnvelope(saved);
  }

  async explain(user: CurrentUser, bowtieId: string): Promise<RiskExplain> {
    const current = await this.getRisk(user, bowtieId);
    const { rows } = await this.pool.query(
      `SELECT id, created_at, trigger, snapshot_json, input_json, health_change_id, classification
       FROM app.risk_snapshot WHERE org_id = $1 AND bowtie_id = $2
         AND simulation_retired_at IS NULL AND snapshot_json IS NOT NULL AND input_json IS NOT NULL
       ORDER BY created_at DESC, id DESC LIMIT 2`, [user.orgId, bowtieId],
    );
    const latest = rows[0];
    const previous = rows[1];
    if (!latest) throw new RiskServiceError(503, "risk_snapshot_unavailable");
    assertClearance(user, latest.classification);
    if (previous) assertClearance(user, previous.classification);
    if (!previous) return {
      bowtieId, hasPrevious: false, summary: "No prior snapshot is available; no change is reported.",
      previous: null, current, changes: [],
    };
    const previousStored = previous.input_json as StoredInput;
    const currentStored = latest.input_json as StoredInput;
    const previousById = new Map(previousStored.input.barriers.map((barrier) => [barrier.id, barrier]));
    const currentById = new Map(currentStored.input.barriers.map((barrier) => [barrier.id, barrier]));
    const currentSnapshot = latest.snapshot_json as RiskSnapshot;
    const changes: RiskChange[] = [];
    const healthChange = latest.health_change_id
      ? await this.pool.query(`SELECT reason, actor FROM app.health_change WHERE org_id = $1 AND id = $2`, [user.orgId, latest.health_change_id])
      : null;
    const changeReason = healthChange?.rows[0]?.reason ? String(healthChange.rows[0].reason) : null;
    for (const barrierId of [...currentById.keys()].sort()) {
      const before = previousById.get(barrierId);
      const after = currentById.get(barrierId);
      if (!before || !after || (before.health === after.health && before.evidenceExpired === after.evidenceExpired && before.pfdBand === after.pfdBand)) continue;
      const counterfactual: RiskInput = structuredClone(currentStored.input);
      const counterfactualBarrier = counterfactual.barriers.find((barrier) => barrier.id === barrierId);
      if (!counterfactualBarrier) continue;
      counterfactualBarrier.health = before.health;
      counterfactualBarrier.evidenceExpired = before.evidenceExpired ?? false;
      counterfactualBarrier.pfdBand = before.pfdBand;
      const beforeCounterfactual = calculateConfiguredRisk(counterfactual);
      const consequenceFrequencyDeltasPerYear = currentSnapshot.consequences.map((consequence) => {
        const prior = beforeCounterfactual.consequences.find((item) => item.consequenceId === consequence.consequenceId);
        return { consequenceId: consequence.consequenceId, delta: prior ? consequence.frequencyPerYear - prior.frequencyPerYear : 0 };
      }).filter((item) => item.delta !== 0);
      const impact = consequenceFrequencyDeltasPerYear.reduce((sum, item) => sum + Math.abs(item.delta), 0);
      const evidenceId = currentStored.evidenceByBarrier[barrierId] ?? null;
      const evidenceExpired = after.evidenceExpired && !before.evidenceExpired;
      changes.push({
        barrierId, beforeHealth: before.health, afterHealth: after.health,
        reason: changeReason ?? (evidenceExpired ? "Evidence is older than the configured interval." : "Barrier risk input changed."),
        sourceEvidenceId: evidenceId,
        sourceEvidenceHref: evidenceId ? `/api/v1/evidence/${evidenceId}` : null,
        topEventFrequencyDeltaPerYear: currentSnapshot.topEventFrequencyPerYear - beforeCounterfactual.topEventFrequencyPerYear,
        consequenceFrequencyDeltasPerYear, impact,
      });
    }
    changes.sort((a, b) => b.impact - a.impact || a.barrierId.localeCompare(b.barrierId));
    return {
      bowtieId, hasPrevious: true,
      summary: changes.length ? "Risk changed after the listed Barrier input changes." : "The score changed without a Barrier input difference between these snapshots.",
      previous: snapshotEnvelope(previous), current, changes,
    };
  }

  async getEvidence(user: CurrentUser, evidenceId: string): Promise<EvidenceSummary> {
    const { rows } = await this.pool.query(
      `SELECT id, barrier_id, kind, source, observed_at, simulated, classification
       FROM app.evidence WHERE org_id = $1 AND id = $2`, [user.orgId, evidenceId],
    );
    const row = rows[0];
    if (!row) throw new RiskServiceError(404, "not_found");
    assertClearance(user, row.classification);
    return {
      id: String(row.id), barrierId: String(row.barrier_id), kind: String(row.kind), source: String(row.source),
      observedAt: asIso(row.observed_at), simulated: Boolean(row.simulated), classification: String(row.classification),
    };
  }

  async riskEventsAfter(user: CurrentUser, cursor: { createdAt: string; id: string } | null): Promise<RiskEvent[]> {
    if (cursor && !UUID_PATTERN.test(cursor.id)) throw new RiskServiceError(400, "validation_failed");
    const result = cursor
      ? await this.pool.query(
        `SELECT id, bowtie_id, created_at, trigger, snapshot_json, classification
         FROM app.risk_snapshot WHERE org_id = $1 AND simulation_retired_at IS NULL AND snapshot_json IS NOT NULL
           AND (created_at, id) > ($2::timestamptz, $3::uuid) ORDER BY created_at, id LIMIT 100`,
        [user.orgId, cursor.createdAt, cursor.id],
      )
      : await this.pool.query(
        `SELECT id, bowtie_id, created_at, trigger, snapshot_json, classification
         FROM app.risk_snapshot WHERE org_id = $1 AND simulation_retired_at IS NULL AND snapshot_json IS NOT NULL
           AND created_at > now() - interval '2 seconds' ORDER BY created_at, id LIMIT 100`, [user.orgId],
      );
    return result.rows.map((row) => {
      assertClearance(user, row.classification);
      return { id: String(row.id), createdAt: asIso(row.created_at), bowtieId: String(row.bowtie_id), snapshotId: String(row.id), trigger: String(row.trigger ?? "recalculated"), snapshot: row.snapshot_json as RiskSnapshot };
    });
  }

  async processHealthChanges(): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT hc.id, hc.org_id, hc.barrier_id, hc.actor, hc.from_health, hc.to_health,
              hc.created_at, hc.simulated, hc.classification
       FROM app.health_change hc
       WHERE EXISTS (SELECT 1 FROM app.organisation org WHERE org.org_id = hc.org_id
           AND org.risk_matrix IS NOT NULL AND org.risk_severity_criteria IS NOT NULL
           AND org.risk_matrix_approved_at IS NOT NULL AND org.risk_matrix_approved_by IS NOT NULL)
         AND EXISTS (
           SELECT 1 FROM app.barrier_path bp
           LEFT JOIN app.threat t ON t.id = bp.threat_id AND t.org_id = bp.org_id
           LEFT JOIN app.consequence c ON c.id = bp.consequence_id AND c.org_id = bp.org_id
           WHERE bp.org_id = hc.org_id AND bp.barrier_id = hc.barrier_id
             AND (t.bowtie_id IS NOT NULL OR c.bowtie_id IS NOT NULL)
             AND NOT EXISTS (SELECT 1 FROM app.risk_snapshot rs WHERE rs.org_id = hc.org_id
               AND rs.health_change_id = hc.id AND rs.bowtie_id = COALESCE(t.bowtie_id, c.bowtie_id))
         )
       ORDER BY hc.created_at, hc.id LIMIT 50`,
    );
    let processed = 0;
    for (const change of rows) {
      const user: CurrentUser = {
        sub: "risk-recalculator", roles: ["fieldloop.manager"], persona: "Risk recalculator",
        orgId: String(change.org_id), clearance: "HIGHLY_RESTRICTED", csrfToken: "", authTime: new Date(),
      };
      const affected = await this.pool.query(
        `SELECT DISTINCT b.id AS bowtie_id FROM app.bowtie b
         JOIN app.threat t ON t.org_id = b.org_id AND t.bowtie_id = b.id
         JOIN app.barrier_path bp ON bp.org_id = b.org_id AND bp.threat_id = t.id
         WHERE b.org_id = $1 AND bp.barrier_id = $2
         UNION
         SELECT DISTINCT b.id FROM app.bowtie b
         JOIN app.consequence c ON c.org_id = b.org_id AND c.bowtie_id = b.id
         JOIN app.barrier_path bp ON bp.org_id = b.org_id AND bp.consequence_id = c.id
         WHERE b.org_id = $1 AND bp.barrier_id = $2`, [user.orgId, change.barrier_id],
      );
      let changeHandled = affected.rows.length === 0;
      for (const affectedBowtie of affected.rows) {
        try {
          const loaded = await this.loadRisk(user, String(affectedBowtie.bowtie_id), {
            id: String(change.id), barrierId: String(change.barrier_id), createdAt: change.created_at,
            fromHealth: change.from_health === null ? null : String(change.from_health), toHealth: String(change.to_health),
          });
          loaded.classification = maxClassification([loaded.classification, change.classification]);
          const snapshot = calculateConfiguredRisk(loaded.stored.input);
          await this.saveSnapshot({
            user, loaded, snapshot, trigger: "health_change", healthChangeId: String(change.id), force: true,
          });
          changeHandled = true;
        } catch (error) {
          if (error instanceof RiskServiceError && ["risk_matrix_unconfigured", "risk_matrix_invalid", "risk_input_invalid"].includes(error.code)) continue;
          throw error;
        }
      }
      if (changeHandled) processed++;
    }
    return processed;
  }

  private async loadRisk(user: CurrentUser, bowtieId: string, healthChange?: HealthChangeCursor): Promise<LoadedRisk> {
    if (!UUID_PATTERN.test(bowtieId)) throw new RiskServiceError(400, "validation_failed");
    const bowtieResult = await this.pool.query<BowtieRow>(
      `SELECT id, hazard, top_event, domain, status, simulated, classification
       FROM app.bowtie WHERE org_id = $1 AND id = $2`, [user.orgId, bowtieId],
    );
    const bowtie = bowtieResult.rows[0];
    if (!bowtie) throw new RiskServiceError(404, "not_found");
    assertClearance(user, bowtie.classification);
    const [orgResult, threatsResult, consequencesResult, groupsResult, pathsResult] = await Promise.all([
      this.pool.query(`SELECT risk_matrix, risk_severity_criteria, risk_matrix_approved_at, risk_matrix_approved_by, classification
        FROM app.organisation WHERE org_id = $1 ORDER BY id LIMIT 1`, [user.orgId]),
      this.pool.query(`SELECT id, frequency_per_year, classification FROM app.threat WHERE org_id = $1 AND bowtie_id = $2 ORDER BY id`, [user.orgId, bowtieId]),
      this.pool.query(`SELECT id, severity, p_conditional, classification FROM app.consequence WHERE org_id = $1 AND bowtie_id = $2 ORDER BY id`, [user.orgId, bowtieId]),
      this.pool.query(`SELECT id, classification FROM app.independence_group WHERE org_id = $1 AND bowtie_id = $2 ORDER BY id`, [user.orgId, bowtieId]),
      this.pool.query(`SELECT bp.id AS path_row_id, bp.position, bp.threat_id, bp.consequence_id,
          bp.classification AS path_classification, b.id AS barrier_id, b.type, b.side, b.pfd_band, b.health,
          b.independence_group_id, b.evidence_interval, b.classification AS barrier_classification
        FROM app.barrier_path bp JOIN app.barrier b ON b.id = bp.barrier_id AND b.org_id = bp.org_id
        WHERE bp.org_id = $1 AND ((bp.threat_id IN (SELECT id FROM app.threat WHERE org_id = $1 AND bowtie_id = $2))
          OR (bp.consequence_id IN (SELECT id FROM app.consequence WHERE org_id = $1 AND bowtie_id = $2)))
        ORDER BY bp.position, bp.id`, [user.orgId, bowtieId]),
    ]);
    const organisation = orgResult.rows[0];
    if (!organisation) throw new RiskServiceError(409, "risk_matrix_unconfigured");
    assertClearance(user, organisation.classification);
    if (!organisation.risk_matrix || !organisation.risk_severity_criteria || !organisation.risk_matrix_approved_at || !organisation.risk_matrix_approved_by) {
      throw new RiskServiceError(409, "risk_matrix_unconfigured");
    }
    if (!isSeverityCriteria(organisation.risk_severity_criteria)) throw new RiskServiceError(409, "risk_matrix_invalid");
    for (const row of [...threatsResult.rows, ...consequencesResult.rows, ...groupsResult.rows, ...pathsResult.rows]) {
      assertClearance(user, row.classification ?? row.path_classification ?? row.barrier_classification);
    }
    const barrierRows = new Map<string, Record<string, unknown>>();
    const pathGroups = new Map<string, { id: string; side: "preventive" | "mitigative"; targetId: string; barrierIds: string[] }>();
    for (const row of pathsResult.rows) {
      const id = String(row.barrier_id);
      barrierRows.set(id, row);
      const side = row.threat_id ? "preventive" : "mitigative";
      const targetId = String(row.threat_id ?? row.consequence_id);
      const key = `${side}:${targetId}`;
      const path = pathGroups.get(key) ?? { id: key, side, targetId, barrierIds: [] };
      path.barrierIds.push(id); pathGroups.set(key, path);
    }
    const barrierIds = [...barrierRows.keys()];
    const evidenceByBarrier: Record<string, string | null> = {};
    const barrierEvidence = new Map<string, { id: string; observedAt: Date; classification: string }>();
    const healthAtChange = new Map(barrierIds.map((id) => [id, String(barrierRows.get(id)?.health ?? "")]));
    if (healthChange && barrierIds.length) {
      const history = await this.pool.query(
        `SELECT id, barrier_id, from_health FROM app.health_change
         WHERE org_id = $1 AND barrier_id = ANY($2::uuid[])
           AND (created_at, id) > ($3::timestamptz, $4::uuid)
         ORDER BY created_at DESC, id DESC`,
        [user.orgId, barrierIds, healthChange.createdAt, healthChange.id],
      );
      for (const change of history.rows) {
        if (change.from_health === null || change.from_health === undefined) {
          throw new RiskServiceError(409, "risk_input_invalid");
        }
        healthAtChange.set(String(change.barrier_id), String(change.from_health));
      }
      healthAtChange.set(healthChange.barrierId, healthChange.toHealth);
    }
    if (barrierIds.length) {
      const evidenceResult = await this.pool.query(
        `SELECT DISTINCT ON (barrier_id) id, barrier_id, observed_at, classification FROM app.evidence
         WHERE org_id = $1 AND barrier_id = ANY($2::uuid[])
           AND ($3::timestamptz IS NULL OR observed_at <= $3::timestamptz)
         ORDER BY barrier_id, observed_at DESC, id DESC`,
        [user.orgId, barrierIds, healthChange?.createdAt ?? null],
      );
      for (const row of evidenceResult.rows) {
        assertClearance(user, row.classification);
        const id = String(row.barrier_id);
        evidenceByBarrier[id] = String(row.id);
        barrierEvidence.set(id, { id: String(row.id), observedAt: new Date(row.observed_at), classification: String(row.classification) });
      }
    }
    for (const id of barrierIds) evidenceByBarrier[id] ??= null;
    const calculationTime = healthChange ? new Date(healthChange.createdAt).getTime() : Date.now();
    const barriers = barrierIds.map((id) => {
      const row = barrierRows.get(id);
      if (!row) throw new RiskServiceError(503, "risk_input_invalid");
      const latest = barrierEvidence.get(id);
      const intervalSeconds = row.evidence_interval === null || row.evidence_interval === undefined
        ? null : parseIntervalSeconds(String(row.evidence_interval));
      const evidenceExpired = intervalSeconds === null ? false : !latest || calculationTime - latest.observedAt.getTime() > intervalSeconds * 1000;
      return {
        id, type: String(row.type) as RiskInput["barriers"][number]["type"],
        side: String(row.side) as RiskInput["barriers"][number]["side"],
        pfdBand: numberValue(row.pfd_band), health: (healthAtChange.get(id) ?? String(row.health)) as RiskInput["barriers"][number]["health"],
        ...(row.independence_group_id ? { independenceGroupId: String(row.independence_group_id) } : {}),
        evidenceExpired,
      };
    });
    const input: RiskInput = {
      bowtieId,
      barriers,
      threats: threatsResult.rows.map((row) => ({ id: String(row.id), frequencyPerYear: numberValue(row.frequency_per_year) })),
      consequences: consequencesResult.rows.map((row) => ({
        id: String(row.id), conditionalProbability: numberValue(row.p_conditional), severity: normalizeSeverity(row.severity),
      })),
      independenceGroups: groupsResult.rows.map((row) => ({ id: String(row.id) })),
      paths: [...pathGroups.values()],
      matrix: organisation.risk_matrix as RiskInput["matrix"],
    };
    const classification = maxClassification([
      bowtie.classification, organisation.classification, ...threatsResult.rows.map((row) => row.classification),
      ...consequencesResult.rows.map((row) => row.classification), ...groupsResult.rows.map((row) => row.classification),
      ...pathsResult.rows.flatMap((row) => [row.path_classification, row.barrier_classification]),
      ...[...barrierEvidence.values()].map((evidence) => evidence.classification),
    ]);
    return { bowtie, stored: { input, evidenceByBarrier }, classification };
  }

  private async latestSnapshot(orgId: string, bowtieId: string): Promise<Record<string, unknown> | null> {
    const { rows } = await this.pool.query(
      `SELECT id, created_at, trigger, snapshot_json, input_json, classification
       FROM app.risk_snapshot WHERE org_id = $1 AND bowtie_id = $2 AND simulation_retired_at IS NULL
         AND snapshot_json IS NOT NULL AND input_json IS NOT NULL
       ORDER BY created_at DESC, id DESC LIMIT 1`, [orgId, bowtieId],
    );
    return rows[0] ?? null;
  }

  private async saveSnapshot(input: {
    user: CurrentUser; loaded: LoadedRisk; snapshot: RiskSnapshot; trigger: string;
    healthChangeId: string | null; force?: boolean;
  }): Promise<Record<string, unknown>> {
    if (!input.force && input.healthChangeId === null) {
      const current = await this.latestSnapshot(input.user.orgId, input.loaded.bowtie.id);
      if (current && canonicalJson(current.snapshot_json) === canonicalJson(input.snapshot)
        && canonicalJson(current.input_json) === canonicalJson(input.loaded.stored)) return current;
    }
    let simulationRunId: string | null = null;
    if (input.loaded.bowtie.simulated) {
      const { rows } = await this.pool.query(`SELECT active_run_id FROM app.simulation_workspace WHERE org_id = $1`, [input.user.orgId]);
      simulationRunId = rows[0]?.active_run_id ? String(rows[0].active_run_id) : null;
    }
    const cellMap = Object.fromEntries(input.snapshot.consequences.map((item) => [item.consequenceId, item.cell]));
    const { rows } = await this.pool.query(
      `INSERT INTO app.risk_snapshot
        (org_id, bowtie_id, top_event_freq, per_consequence_cells, trigger, simulated, classification,
         created_by, snapshot_json, input_json, health_change_id, simulation_run_id)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::uuid,$12::uuid)
       ON CONFLICT (org_id, bowtie_id, health_change_id) WHERE health_change_id IS NOT NULL DO NOTHING
       RETURNING id, created_at, trigger, snapshot_json, input_json`,
      [input.user.orgId, input.loaded.bowtie.id, input.snapshot.topEventFrequencyPerYear,
        JSON.stringify(cellMap), input.trigger, input.loaded.bowtie.simulated, input.loaded.classification,
        input.user.sub, JSON.stringify(input.snapshot), JSON.stringify(input.loaded.stored), input.healthChangeId, simulationRunId],
    );
    if (rows[0]) return rows[0];
    const existing = input.healthChangeId ? await this.pool.query(
      `SELECT id, created_at, trigger, snapshot_json, input_json FROM app.risk_snapshot
       WHERE org_id = $1 AND bowtie_id = $2 AND health_change_id = $3 AND simulation_retired_at IS NULL LIMIT 1`,
      [input.user.orgId, input.loaded.bowtie.id, input.healthChangeId],
    ) : null;
    if (existing?.rows[0]) return existing.rows[0];
    throw new RiskServiceError(503, "risk_snapshot_unavailable");
  }
}

function summary(row: BowtieRow): BowtieSummary {
  return { id: row.id, hazard: row.hazard, topEvent: row.top_event, domain: row.domain, status: row.status, simulated: row.simulated, classification: row.classification };
}

function isSeverityCriteria(value: unknown): value is SeverityCriteria {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const criteria = value as Record<string, unknown>;
  const dimensions: (keyof SeverityCriteria)[] = ["people", "environment", "financial", "serviceContinuity", "reputation", "legalRegulatory"];
  return Object.keys(criteria).length === dimensions.length && dimensions.every((dimension) => {
    const entries = criteria[dimension];
    return Array.isArray(entries) && entries.length === 5 && entries.every((entry) => typeof entry === "string" && entry.trim().length > 0);
  });
}

function calculateConfiguredRisk(input: RiskInput): RiskSnapshot {
  assertRiskMatrix(input.matrix);
  try {
    return calculateRisk(input);
  } catch (error) {
    if (error instanceof RiskInputError) throw new RiskServiceError(409, "risk_input_invalid");
    throw error;
  }
}

function assertRiskMatrix(value: unknown): asserts value is RiskMatrix {
  const checkInput: RiskInput = {
    bowtieId: "matrix-check",
    barriers: [],
    threats: [{ id: "threat-check", frequencyPerYear: 0 }],
    consequences: [{ id: "consequence-check", conditionalProbability: 0, severity: { people: 1 } }],
    independenceGroups: [],
    paths: [{ id: "path-check", side: "preventive", targetId: "threat-check", barrierIds: [] }],
    matrix: value as RiskMatrix,
  };
  if (riskInputErrors(checkInput).length > 0) throw new RiskServiceError(409, "risk_matrix_invalid");
  const matrix = value as RiskMatrix;
  for (let index = 1; index < matrix.frequencyThresholds.length; index++) {
    if ((matrix.frequencyThresholds[index] ?? 0) <= (matrix.frequencyThresholds[index - 1] ?? 0)) {
      throw new RiskServiceError(409, "risk_matrix_invalid");
    }
  }
  const zoneOrder = { green: 0, amber: 1, red: 2 };
  for (let row = 0; row < 5; row++) {
    for (let column = 0; column < 5; column++) {
      const cell = matrix.cells[row]?.[column];
      if (!cell) throw new RiskServiceError(409, "risk_matrix_invalid");
      for (const previous of [matrix.cells[row - 1]?.[column], matrix.cells[row]?.[column - 1]]) {
        if (previous && (zoneOrder[cell.zone] < zoneOrder[previous.zone]
          || (cell.zone === previous.zone && cell.rank < previous.rank))) {
          throw new RiskServiceError(409, "risk_matrix_invalid");
        }
      }
    }
  }
}

function assertClearance(user: CurrentUser, classification: unknown): asserts classification is string {
  const level = CLASSIFICATIONS.indexOf(String(classification) as typeof CLASSIFICATIONS[number]);
  const clearance = CLASSIFICATIONS.indexOf(user.clearance as typeof CLASSIFICATIONS[number]);
  if (level < 0 || clearance < level) throw new RiskServiceError(403, "clearance_denied");
}

function maxClassification(values: unknown[]): string {
  const levels = values.map((value) => CLASSIFICATIONS.indexOf(String(value) as typeof CLASSIFICATIONS[number]));
  if (levels.some((level) => level < 0)) throw new RiskServiceError(503, "risk_input_invalid");
  return CLASSIFICATIONS[Math.max(...levels)] ?? "HIGHLY_RESTRICTED";
}

function normalizeSeverity(value: unknown): Record<string, number> {
  const raw = typeof value === "string" ? JSON.parse(value) as Record<string, unknown> : value as Record<string, unknown>;
  const result: Record<string, number> = {};
  for (const [key, band] of Object.entries(raw ?? {})) {
    const normalized = key === "service_continuity" ? "serviceContinuity"
      : key === "legal_regulatory" ? "legalRegulatory" : key;
    result[normalized] = Number(band);
  }
  return result;
}

function numberValue(value: unknown): number {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new RiskServiceError(503, "risk_input_invalid");
  return result;
}

function parseIntervalSeconds(value: string): number {
  const match = /^(?:(\d+) years? )?(?:(\d+) mons? )?(?:(\d+) days? )?(?:(\d+):(\d+):(\d+(?:\.\d+)?))?$/.exec(value.trim());
  if (!match) throw new RiskServiceError(503, "risk_input_invalid");
  return Number(match[1] ?? 0) * 365.25 * 86400 + Number(match[2] ?? 0) * 30.4375 * 86400 + Number(match[3] ?? 0) * 86400
    + Number(match[4] ?? 0) * 3600 + Number(match[5] ?? 0) * 60 + Number(match[6] ?? 0);
}

function asIso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new RiskServiceError(503, "risk_input_invalid");
  return date.toISOString();
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function snapshotEnvelope(row: Record<string, unknown>): RiskSnapshotEnvelope {
  return { id: String(row.id), createdAt: asIso(row.created_at), trigger: String(row.trigger ?? "initial"), snapshot: row.snapshot_json as RiskSnapshot };
}
