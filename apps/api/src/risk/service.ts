import { createHash } from "node:crypto";
import { DEMO_RISK_MATRIX } from "@fieldloop/domain";
import { calculateRisk, calculateRiskChangeImpact, isEvidenceExpired, RiskInputError, validateRiskMatrix } from "@fieldloop/domain/risk";
import type { RiskInput, RiskSnapshot } from "@fieldloop/contracts";
import { sql, type Kysely } from "kysely";
import type { CurrentUser } from "../auth/service.js";
import type { RiskDatabase } from "./database.js";

const CLASSIFICATIONS = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED"] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEMO_SEED_CREATORS = ["seed:dl-01", "seed:bangkok"] as const;
const DEMO_RISK_CALIBRATION: RiskCalibration = {
  standardRef: "FieldLoop PRD §7.2 demo Risk Matrix",
  standardVersion: "demo-1",
  approvedBy: "Owner-approved FieldLoop demo policy",
  approvedAt: "2026-10-14T00:00:00.000Z",
};

export class RiskServiceError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export interface RiskSnapshotEnvelope {
  id: string;
  createdAt: string;
  trigger: string;
  calibration: RiskCalibration;
  snapshot: RiskSnapshot;
}

export interface RiskCalibration {
  standardRef: string;
  standardVersion: string;
  approvedBy: string;
  approvedAt: string;
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
  riskInputChanges: RiskInputChange[];
}

export interface RiskInputChange {
  path: string;
  beforeValue: string | null;
  afterValue: string | null;
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
  calibration: RiskCalibration;
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
  calibration: RiskCalibration;
}

interface BowtieRow {
  id: string;
  hazard: string;
  top_event: string;
  domain: string | null;
  status: string | null;
  simulated: boolean;
  classification: string;
  created_by?: string;
}

interface LoadedRisk {
  bowtie: BowtieRow;
  stored: StoredInput;
  classification: string;
}

export class PostgresRiskService implements RiskApiPort {
  constructor(private readonly db: Kysely<RiskDatabase>) {}

  async listBowties(user: CurrentUser): Promise<BowtieSummary[]> {
    const rows = await this.db.withSchema("app").selectFrom("bowtie")
      .select(["id", "hazard", "top_event", "domain", "status", "simulated", "classification"])
      .where("org_id", "=", user.orgId).orderBy("id").execute();
    return rows.map((row) => {
      assertClearance(user, row.classification);
      return summary(row);
    });
  }

  async getBowtie(user: CurrentUser, bowtieId: string): Promise<BowtieCanvas> {
    if (!UUID_PATTERN.test(bowtieId)) throw new RiskServiceError(400, "validation_failed");
    const bowtie = await this.db.withSchema("app").selectFrom("bowtie")
      .select(["id", "hazard", "top_event", "domain", "status", "simulated", "classification"])
      .where("org_id", "=", user.orgId).where("id", "=", bowtieId).executeTakeFirst();
    if (!bowtie) throw new RiskServiceError(404, "not_found");
    assertClearance(user, bowtie.classification);
    const organisation = await this.db.withSchema("app").selectFrom("organisation")
      .select(["risk_matrix", "risk_severity_criteria", "risk_matrix_approved_at", "risk_matrix_approved_by",
        "risk_matrix_standard_ref", "risk_matrix_standard_version", "classification"])
      .where("org_id", "=", user.orgId).orderBy("id").limit(1).executeTakeFirst();
    if (organisation) assertClearance(user, organisation.classification);
    const calibration = organisation ? readCalibration(organisation) : null;
    const severityCriteria = organisation?.risk_matrix && calibration
      && isSeverityCriteria(organisation.risk_severity_criteria)
      ? organisation.risk_severity_criteria as SeverityCriteria : null;
    const threats = await this.db.withSchema("app").selectFrom("threat")
      .select(["id", "name", "frequency_per_year", "classification"])
      .where("org_id", "=", user.orgId).where("bowtie_id", "=", bowtieId).orderBy("id").execute();
    const consequences = await this.db.withSchema("app").selectFrom("consequence")
      .select(["id", "name", "severity", "classification"])
      .where("org_id", "=", user.orgId).where("bowtie_id", "=", bowtieId).orderBy("id").execute();
    const threatIds = this.db.withSchema("app").selectFrom("threat").select("id")
      .where("org_id", "=", user.orgId).where("bowtie_id", "=", bowtieId);
    const consequenceIds = this.db.withSchema("app").selectFrom("consequence").select("id")
      .where("org_id", "=", user.orgId).where("bowtie_id", "=", bowtieId);
    const barriers = await this.db.withSchema("app").selectFrom("barrier_path as bp")
      .innerJoin("barrier as b", (join) => join.onRef("b.id", "=", "bp.barrier_id").onRef("b.org_id", "=", "bp.org_id"))
      .select(["b.id", "b.name", "b.type", "b.side", "b.health", "b.pfd_band", "b.classification"])
      .distinct().where("bp.org_id", "=", user.orgId)
      .where((eb) => eb.or([eb("bp.threat_id", "in", threatIds), eb("bp.consequence_id", "in", consequenceIds)]))
      .orderBy("b.id").execute();
    const factors = barriers.length ? await this.db.withSchema("app").selectFrom("degradation_factor")
      .select(["barrier_id", "description", "classification"])
      .where("org_id", "=", user.orgId).where("barrier_id", "in", barriers.map((barrier) => barrier.id))
      .orderBy("barrier_id").orderBy("id").execute() : [];
    const pathRows = await this.db.withSchema("app").selectFrom("barrier_path as bp")
      .innerJoin("barrier as b", (join) => join.onRef("b.id", "=", "bp.barrier_id").onRef("b.org_id", "=", "bp.org_id"))
      .select(["bp.id", "bp.position", "bp.threat_id", "bp.consequence_id", "bp.classification as path_classification",
        "b.id as barrier_id", "b.side as barrier_side", "b.classification as barrier_classification"])
      .where("bp.org_id", "=", user.orgId)
      .where((eb) => eb.or([eb("bp.threat_id", "in", threatIds), eb("bp.consequence_id", "in", consequenceIds)]))
      .orderBy("bp.position").orderBy("bp.id").execute();
    for (const row of [...threats, ...consequences, ...barriers]) assertClearance(user, row.classification);
    for (const row of pathRows) {
      assertClearance(user, row.path_classification);
      assertClearance(user, row.barrier_classification);
    }
    const factorsByBarrier = new Map<string, string[]>();
    for (const factor of factors) {
      assertClearance(user, factor.classification);
      const values = factorsByBarrier.get(factor.barrier_id) ?? [];
      values.push(factor.description);
      factorsByBarrier.set(factor.barrier_id, values);
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
    const currentStored = current?.input_json as StoredInput | undefined;
    const sameSnapshot = current && canonicalJson(current.snapshot_json) === canonicalJson(snapshot)
      && canonicalJson(currentStored?.input) === canonicalJson(loaded.stored.input)
      && canonicalJson(currentStored?.calibration) === canonicalJson(loaded.stored.calibration);
    if (sameSnapshot) return snapshotEnvelope(current);
    const saved = await this.saveSnapshot({
      user, loaded, snapshot, trigger: current ? "recalculated" : "initial", healthChangeId: null,
    });
    return snapshotEnvelope(saved);
  }

  async explain(user: CurrentUser, bowtieId: string): Promise<RiskExplain> {
    const current = await this.getRisk(user, bowtieId);
    const rows = await this.db.withSchema("app").selectFrom("risk_snapshot")
      .select(["id", "created_at", "trigger", "snapshot_json", "input_json", "health_change_id", "classification"])
      .where("org_id", "=", user.orgId).where("bowtie_id", "=", bowtieId)
      .where("simulation_retired_at", "is", null).where("snapshot_json", "is not", null)
      .where("input_json", "is not", null)
      .where(sql<boolean>`input_json->'calibration' is not null`)
      .orderBy("created_at", "desc").orderBy("id", "desc").limit(2).execute();
    const latest = rows[0];
    const previous = rows[1];
    if (!latest) throw new RiskServiceError(503, "risk_snapshot_unavailable");
    assertClearance(user, latest.classification);
    if (previous) assertClearance(user, previous.classification);
    if (!previous) return {
      bowtieId, hasPrevious: false, summary: "No prior snapshot is available; no change is reported.",
      previous: null, current, changes: [], riskInputChanges: [],
    };
    const previousStored = previous.input_json as StoredInput;
    const currentStored = latest.input_json as StoredInput;
    const riskInputChanges = diffRiskInputs(previousStored, currentStored);
    const previousById = new Map(previousStored.input.barriers.map((barrier) => [barrier.id, barrier]));
    const currentById = new Map(currentStored.input.barriers.map((barrier) => [barrier.id, barrier]));
    const currentSnapshot = latest.snapshot_json as RiskSnapshot;
    const changes: RiskChange[] = [];
    const healthChange = latest.health_change_id
      ? await this.db.withSchema("app").selectFrom("health_change").select(["barrier_id", "reason", "actor"])
        .where("org_id", "=", user.orgId).where("id", "=", latest.health_change_id).executeTakeFirst()
      : undefined;
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
      const impact = calculateRiskChangeImpact(consequenceFrequencyDeltasPerYear.map((item) => item.delta));
      const evidenceId = currentStored.evidenceByBarrier[barrierId] ?? null;
      const evidenceExpired = after.evidenceExpired && !before.evidenceExpired;
      const barrierHealthChange = healthChange && String(healthChange.barrier_id) === barrierId ? healthChange : undefined;
      const changeReason = barrierHealthChange?.reason ? String(barrierHealthChange.reason) : null;
      const reason = barrierHealthChange?.actor === "ageing" || evidenceExpired
        ? "Evidence older than interval"
        : changeReason ?? "Barrier risk input changed.";
      changes.push({
        barrierId, beforeHealth: before.health, afterHealth: after.health,
        reason,
        sourceEvidenceId: evidenceId,
        sourceEvidenceHref: evidenceId ? `/api/v1/evidence/${evidenceId}` : null,
        topEventFrequencyDeltaPerYear: currentSnapshot.topEventFrequencyPerYear - beforeCounterfactual.topEventFrequencyPerYear,
        consequenceFrequencyDeltasPerYear, impact,
      });
    }
    changes.sort((a, b) => b.impact - a.impact || a.barrierId.localeCompare(b.barrierId));
    return {
      bowtieId, hasPrevious: true,
      summary: changes.length && riskInputChanges.length
        ? "Risk changed after the listed Barrier and risk input changes."
        : changes.length ? "Risk changed after the listed Barrier input changes."
          : riskInputChanges.length ? "Risk changed after the listed risk input changes."
            : "Risk changed without a recorded risk input difference between these snapshots.",
      previous: snapshotEnvelope(previous), current, changes, riskInputChanges,
    };
  }

  async getEvidence(user: CurrentUser, evidenceId: string): Promise<EvidenceSummary> {
    const row = await this.db.withSchema("app").selectFrom("evidence")
      .select(["id", "barrier_id", "kind", "source", "observed_at", "simulated", "classification"])
      .where("org_id", "=", user.orgId).where("id", "=", evidenceId).executeTakeFirst();
    if (!row) throw new RiskServiceError(404, "not_found");
    assertClearance(user, row.classification);
    return {
      id: String(row.id), barrierId: String(row.barrier_id), kind: String(row.kind), source: String(row.source),
      observedAt: asIso(row.observed_at), simulated: Boolean(row.simulated), classification: String(row.classification),
    };
  }

  async riskEventsAfter(user: CurrentUser, cursor: { createdAt: string; id: string } | null): Promise<RiskEvent[]> {
    if (cursor && !UUID_PATTERN.test(cursor.id)) throw new RiskServiceError(400, "validation_failed");
    let query = this.db.withSchema("app").selectFrom("risk_snapshot")
      .select(["id", "bowtie_id", "created_at", "trigger", "snapshot_json", "input_json", "classification"])
      .where("org_id", "=", user.orgId).where("simulation_retired_at", "is", null)
      .where("snapshot_json", "is not", null).where(sql<boolean>`input_json->'calibration' is not null`);
    if (cursor) {
      query = query.where((eb) => eb.or([
        eb("created_at", ">", new Date(cursor.createdAt)),
        eb.and([eb("created_at", "=", new Date(cursor.createdAt)), eb("id", ">", cursor.id)]),
      ]));
    } else {
      query = query.where("created_at", ">", sql<Date>`now() - interval '2 seconds'`);
    }
    const rows = await query.orderBy("created_at").orderBy("id").limit(100).execute();
    return rows.map((row) => {
      assertClearance(user, row.classification);
      const envelope = snapshotEnvelope(row);
      return { id: envelope.id, createdAt: envelope.createdAt, bowtieId: String(row.bowtie_id), snapshotId: envelope.id,
        trigger: envelope.trigger, calibration: envelope.calibration, snapshot: envelope.snapshot };
    });
  }

  async processHealthChanges(): Promise<number> {
    const rows = await this.db.withSchema("app").selectFrom("health_change as hc")
      .select(["hc.id", "hc.org_id", "hc.barrier_id", "hc.actor", "hc.from_health", "hc.to_health",
        "hc.created_at", "hc.simulated", "hc.classification"])
      .where((eb) => eb.or([
        eb.exists(eb.selectFrom("organisation as org").select("org.id")
        .whereRef("org.org_id", "=", "hc.org_id")
        .where("org.risk_matrix", "is not", null).where("org.risk_severity_criteria", "is not", null)
        .where("org.risk_matrix_approved_at", "is not", null)
        .where(sql<boolean>`nullif(btrim(org.risk_matrix_approved_by), '') is not null`)
        .where(sql<boolean>`nullif(btrim(org.risk_matrix_standard_ref), '') is not null`)
        .where(sql<boolean>`nullif(btrim(org.risk_matrix_standard_version), '') is not null`)),
        eb.and([
          eb("hc.simulated", "=", true),
          eb.or([
            eb.exists(eb.selectFrom("threat as t").innerJoin("barrier_path as bp", (join) => join
              .onRef("bp.threat_id", "=", "t.id").onRef("bp.org_id", "=", "t.org_id"))
              .innerJoin("barrier as b", (join) => join.onRef("b.id", "=", "bp.barrier_id").onRef("b.org_id", "=", "bp.org_id"))
              .innerJoin("bowtie as bt", (join) => join.onRef("bt.id", "=", "t.bowtie_id").onRef("bt.org_id", "=", "t.org_id"))
              .select("t.id").whereRef("bp.org_id", "=", "hc.org_id").whereRef("bp.barrier_id", "=", "hc.barrier_id")
              .where("bt.simulated", "=", true).where("bt.created_by", "in", DEMO_SEED_CREATORS)
              .where("t.simulated", "=", true).where("t.created_by", "in", DEMO_SEED_CREATORS)
              .where("bp.simulated", "=", true).where("bp.created_by", "in", DEMO_SEED_CREATORS)
              .where("b.simulated", "=", true).where("b.created_by", "in", DEMO_SEED_CREATORS)),
            eb.exists(eb.selectFrom("consequence as c").innerJoin("barrier_path as bp", (join) => join
              .onRef("bp.consequence_id", "=", "c.id").onRef("bp.org_id", "=", "c.org_id"))
              .innerJoin("barrier as b", (join) => join.onRef("b.id", "=", "bp.barrier_id").onRef("b.org_id", "=", "bp.org_id"))
              .innerJoin("bowtie as bt", (join) => join.onRef("bt.id", "=", "c.bowtie_id").onRef("bt.org_id", "=", "c.org_id"))
              .select("c.id").whereRef("bp.org_id", "=", "hc.org_id").whereRef("bp.barrier_id", "=", "hc.barrier_id")
              .where("bt.simulated", "=", true).where("bt.created_by", "in", DEMO_SEED_CREATORS)
              .where("c.simulated", "=", true).where("c.created_by", "in", DEMO_SEED_CREATORS)
              .where("bp.simulated", "=", true).where("bp.created_by", "in", DEMO_SEED_CREATORS)
              .where("b.simulated", "=", true).where("b.created_by", "in", DEMO_SEED_CREATORS)),
          ]),
        ]),
      ]))
      .where((eb) => eb.exists(eb.selectFrom("barrier_path as bp")
        .leftJoin("threat as t", (join) => join.onRef("t.id", "=", "bp.threat_id").onRef("t.org_id", "=", "bp.org_id"))
        .leftJoin("consequence as c", (join) => join.onRef("c.id", "=", "bp.consequence_id").onRef("c.org_id", "=", "bp.org_id"))
        .select("bp.id").whereRef("bp.org_id", "=", "hc.org_id").whereRef("bp.barrier_id", "=", "hc.barrier_id")
        .where((pathEb) => pathEb.or([pathEb("t.bowtie_id", "is not", null), pathEb("c.bowtie_id", "is not", null)]))
        .where((pathEb) => pathEb.not(pathEb.exists(pathEb.selectFrom("risk_snapshot as rs").select("rs.id")
          .whereRef("rs.org_id", "=", "hc.org_id").whereRef("rs.health_change_id", "=", "hc.id")
          .where(sql<boolean>`rs.bowtie_id = coalesce(t.bowtie_id, c.bowtie_id)`))))))
      .orderBy("hc.created_at").orderBy("hc.id").limit(50).execute();
    let processed = 0;
    for (const change of rows) {
      const user: CurrentUser = {
        sub: "risk-recalculator", roles: ["fieldloop.manager"], persona: "Risk recalculator",
        orgId: String(change.org_id), clearance: "HIGHLY_RESTRICTED", csrfToken: "", authTime: new Date(),
      };
      const affected = await this.db.withSchema("app").selectFrom("bowtie as b")
        .select("b.id as bowtie_id").distinct().where("b.org_id", "=", user.orgId)
        .where((eb) => eb.or([
          eb.exists(eb.selectFrom("threat as t").innerJoin("barrier_path as bp", (join) => join
            .onRef("bp.threat_id", "=", "t.id").onRef("bp.org_id", "=", "t.org_id"))
            .select("t.id").whereRef("t.org_id", "=", "b.org_id").whereRef("t.bowtie_id", "=", "b.id")
            .where("bp.barrier_id", "=", String(change.barrier_id))),
          eb.exists(eb.selectFrom("consequence as c").innerJoin("barrier_path as bp", (join) => join
            .onRef("bp.consequence_id", "=", "c.id").onRef("bp.org_id", "=", "c.org_id"))
            .select("c.id").whereRef("c.org_id", "=", "b.org_id").whereRef("c.bowtie_id", "=", "b.id")
            .where("bp.barrier_id", "=", String(change.barrier_id))),
        ])).execute();
      let changeHandled = affected.length === 0;
      for (const affectedBowtie of affected) {
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
    const bowtie = await this.db.withSchema("app").selectFrom("bowtie")
      .select(["id", "hazard", "top_event", "domain", "status", "simulated", "classification", "created_by"])
      .where("org_id", "=", user.orgId).where("id", "=", bowtieId).executeTakeFirst();
    if (!bowtie) throw new RiskServiceError(404, "not_found");
    assertClearance(user, bowtie.classification);
    const threatIds = this.db.withSchema("app").selectFrom("threat").select("id")
      .where("org_id", "=", user.orgId).where("bowtie_id", "=", bowtieId);
    const consequenceIds = this.db.withSchema("app").selectFrom("consequence").select("id")
      .where("org_id", "=", user.orgId).where("bowtie_id", "=", bowtieId);
    const [organisation, threats, consequences, groups, paths] = await Promise.all([
      this.db.withSchema("app").selectFrom("organisation")
        .select(["risk_matrix", "risk_severity_criteria", "risk_matrix_approved_at", "risk_matrix_approved_by",
          "risk_matrix_standard_ref", "risk_matrix_standard_version", "classification"])
        .where("org_id", "=", user.orgId).orderBy("id").limit(1).executeTakeFirst(),
      this.db.withSchema("app").selectFrom("threat").select(["id", "frequency_per_year", "simulated", "classification", "created_by"])
        .where("org_id", "=", user.orgId).where("bowtie_id", "=", bowtieId).orderBy("id").execute(),
      this.db.withSchema("app").selectFrom("consequence").select(["id", "severity", "p_conditional", "simulated", "classification", "created_by"])
        .where("org_id", "=", user.orgId).where("bowtie_id", "=", bowtieId).orderBy("id").execute(),
      this.db.withSchema("app").selectFrom("independence_group").select(["id", "simulated", "classification", "created_by"])
        .where("org_id", "=", user.orgId).where("bowtie_id", "=", bowtieId).orderBy("id").execute(),
      this.db.withSchema("app").selectFrom("barrier_path as bp")
        .innerJoin("barrier as b", (join) => join.onRef("b.id", "=", "bp.barrier_id").onRef("b.org_id", "=", "bp.org_id"))
        .select(["bp.id as path_row_id", "bp.position", "bp.threat_id", "bp.consequence_id",
          "bp.classification as path_classification", "b.id as barrier_id", "b.type", "b.side", "b.pfd_band", "b.health",
          "bp.simulated as path_simulated", "bp.created_by as path_created_by",
          "b.independence_group_id", "b.evidence_interval", "b.simulated as barrier_simulated",
          "b.created_by as barrier_created_by", "b.classification as barrier_classification"])
        .where("bp.org_id", "=", user.orgId)
        .where((eb) => eb.or([eb("bp.threat_id", "in", threatIds), eb("bp.consequence_id", "in", consequenceIds)]))
        .orderBy("bp.position").orderBy("bp.id").execute(),
    ]);
    if (!organisation) throw new RiskServiceError(409, "risk_matrix_unconfigured");
    assertClearance(user, organisation.classification);
    const calibration = organisation ? readCalibration(organisation) : null;
    const demoSeedEligible = isDemoSeedGraph(bowtie, threats, consequences, groups, paths);
    const hasOrganisationCalibration = hasCalibrationValues(organisation);
    let selectedCalibration: RiskCalibration;
    let selectedMatrix: RiskInput["matrix"];
    if (organisation?.risk_matrix && organisation.risk_severity_criteria && calibration) {
      if (!isSeverityCriteria(organisation.risk_severity_criteria)) throw new RiskServiceError(409, "risk_matrix_invalid");
      selectedCalibration = calibration;
      selectedMatrix = organisation.risk_matrix as RiskInput["matrix"];
    } else if (!hasOrganisationCalibration && demoSeedEligible) {
      selectedCalibration = DEMO_RISK_CALIBRATION;
      selectedMatrix = DEMO_RISK_MATRIX;
    } else {
      throw new RiskServiceError(409, "risk_matrix_unconfigured");
    }
    for (const row of [...threats, ...consequences, ...groups]) assertClearance(user, row.classification);
    for (const row of paths) {
      assertClearance(user, row.path_classification);
      assertClearance(user, row.barrier_classification);
    }
    const barrierRows = new Map<string, Record<string, unknown>>();
    const pathGroups = new Map<string, { id: string; side: "preventive" | "mitigative"; targetId: string; barrierIds: string[] }>();
    for (const row of paths) {
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
      const history = await this.db.withSchema("app").selectFrom("health_change")
        .select(["id", "barrier_id", "from_health"])
        .where("org_id", "=", user.orgId).where("barrier_id", "in", barrierIds)
        .where((eb) => eb.or([
          eb("created_at", ">", new Date(healthChange.createdAt)),
          eb.and([eb("created_at", "=", new Date(healthChange.createdAt)), eb("id", ">", healthChange.id)]),
        ]))
        .orderBy("created_at", "desc").orderBy("id", "desc").execute();
      for (const change of history) {
        if (change.from_health === null || change.from_health === undefined) {
          throw new RiskServiceError(409, "risk_input_invalid");
        }
        healthAtChange.set(String(change.barrier_id), String(change.from_health));
      }
      healthAtChange.set(healthChange.barrierId, healthChange.toHealth);
    }
    if (barrierIds.length) {
      let evidenceQuery = this.db.withSchema("app").selectFrom("evidence")
        .distinctOn("barrier_id").select(["id", "barrier_id", "observed_at", "classification", "simulated", "created_by"])
        .where("org_id", "=", user.orgId).where("barrier_id", "in", barrierIds);
      if (selectedCalibration === DEMO_RISK_CALIBRATION) {
        evidenceQuery = evidenceQuery.where("simulated", "=", true).where("created_by", "in", DEMO_SEED_CREATORS);
      }
      if (healthChange) evidenceQuery = evidenceQuery.where("observed_at", "<=", new Date(healthChange.createdAt));
      const evidenceRows = await evidenceQuery.orderBy("barrier_id").orderBy("observed_at", "desc").orderBy("id", "desc").execute();
      for (const row of evidenceRows) {
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
      const evidenceExpired = isEvidenceExpired(latest?.observedAt.getTime() ?? null, calculationTime, intervalSeconds);
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
      threats: threats.map((row) => ({ id: String(row.id), frequencyPerYear: numberValue(row.frequency_per_year) })),
      consequences: consequences.map((row) => ({
        id: String(row.id), conditionalProbability: numberValue(row.p_conditional), severity: normalizeSeverity(row.severity),
      })),
      independenceGroups: groups.map((row) => ({ id: String(row.id) })),
      paths: [...pathGroups.values()],
      matrix: selectedMatrix,
    };
    const classification = maxClassification([
      bowtie.classification, organisation.classification, ...threats.map((row) => row.classification),
      ...consequences.map((row) => row.classification), ...groups.map((row) => row.classification),
      ...paths.flatMap((row) => [row.path_classification, row.barrier_classification]),
      ...[...barrierEvidence.values()].map((evidence) => evidence.classification),
    ]);
    return { bowtie, stored: { input, evidenceByBarrier, calibration: selectedCalibration }, classification };
  }

  private async latestSnapshot(orgId: string, bowtieId: string) {
    return this.db.withSchema("app").selectFrom("risk_snapshot")
      .select(["id", "created_at", "trigger", "snapshot_json", "input_json", "classification"])
      .where("org_id", "=", orgId).where("bowtie_id", "=", bowtieId)
      .where("simulation_retired_at", "is", null).where("snapshot_json", "is not", null)
      .where("input_json", "is not", null).where(sql<boolean>`input_json->'calibration' is not null`)
      .orderBy("created_at", "desc").orderBy("id", "desc").limit(1).executeTakeFirst();
  }

  private async saveSnapshot(input: {
    user: CurrentUser; loaded: LoadedRisk; snapshot: RiskSnapshot; trigger: string;
    healthChangeId: string | null; force?: boolean;
  }): Promise<Record<string, unknown>> {
    if (!input.force && input.healthChangeId === null) {
      const current = await this.latestSnapshot(input.user.orgId, input.loaded.bowtie.id);
      const currentStored = current?.input_json as StoredInput | undefined;
      if (current && canonicalJson(current.snapshot_json) === canonicalJson(input.snapshot)
        && canonicalJson(currentStored?.input) === canonicalJson(input.loaded.stored.input)
        && canonicalJson(currentStored?.calibration) === canonicalJson(input.loaded.stored.calibration)) return current;
    }
    let simulationRunId: string | null = null;
    if (input.loaded.bowtie.simulated) {
      const workspace = await this.db.withSchema("app").selectFrom("simulation_workspace").select("active_run_id")
        .where("org_id", "=", input.user.orgId).executeTakeFirst();
      simulationRunId = workspace?.active_run_id ? String(workspace.active_run_id) : null;
    }
    const cellMap = Object.fromEntries(input.snapshot.consequences.map((item) => [item.consequenceId, item.cell]));
    const fingerprint = createHash("sha256").update(canonicalJson({
      snapshot: input.snapshot, input: input.loaded.stored.input, calibration: input.loaded.stored.calibration,
    })).digest("hex");
    const inserted = await this.db.withSchema("app").insertInto("risk_snapshot")
      .values({
        org_id: input.user.orgId, bowtie_id: input.loaded.bowtie.id,
        top_event_freq: input.snapshot.topEventFrequencyPerYear, per_consequence_cells: cellMap,
        trigger: input.trigger, simulated: input.loaded.bowtie.simulated,
        classification: input.loaded.classification, created_by: input.user.sub,
        snapshot_json: input.snapshot, input_json: input.loaded.stored,
        health_change_id: input.healthChangeId, simulation_run_id: simulationRunId, input_fingerprint: fingerprint,
      })
      .onConflict((conflict) => input.healthChangeId
        ? conflict.columns(["org_id", "bowtie_id", "health_change_id"])
          .where("health_change_id", "is not", null).doNothing()
        : conflict.columns(["org_id", "bowtie_id", "input_fingerprint"])
          .where("health_change_id", "is", null).where("input_fingerprint", "is not", null)
          .where("simulation_retired_at", "is", null).doNothing())
      .returning(["id", "created_at", "trigger", "snapshot_json", "input_json"]).executeTakeFirst();
    if (inserted) return inserted;
    let existingQuery = this.db.withSchema("app").selectFrom("risk_snapshot")
      .select(["id", "created_at", "trigger", "snapshot_json", "input_json"])
      .where("org_id", "=", input.user.orgId).where("bowtie_id", "=", input.loaded.bowtie.id)
      .where("simulation_retired_at", "is", null);
    existingQuery = input.healthChangeId
      ? existingQuery.where("health_change_id", "=", input.healthChangeId)
      : existingQuery.where("input_fingerprint", "=", fingerprint).where("health_change_id", "is", null);
    const existing = await existingQuery.limit(1).executeTakeFirst();
    if (existing) return existing;
    throw new RiskServiceError(503, "risk_snapshot_unavailable");
  }
}

function summary(row: BowtieRow): BowtieSummary {
  return { id: row.id, hazard: row.hazard, topEvent: row.top_event, domain: row.domain, status: row.status, simulated: row.simulated, classification: row.classification };
}

function hasCalibrationValues(organisation: {
  risk_matrix: unknown;
  risk_severity_criteria: unknown;
  risk_matrix_approved_at: unknown;
  risk_matrix_approved_by: unknown;
  risk_matrix_standard_ref: unknown;
  risk_matrix_standard_version: unknown;
}): boolean {
  return [organisation.risk_matrix, organisation.risk_severity_criteria, organisation.risk_matrix_approved_at,
    organisation.risk_matrix_approved_by, organisation.risk_matrix_standard_ref, organisation.risk_matrix_standard_version]
    .some((value) => value !== null && value !== undefined);
}

function isDemoSeedRecord(row: { simulated: boolean; created_by: string }): boolean {
  return row.simulated && DEMO_SEED_CREATORS.some((creator) => row.created_by === creator);
}

function isDemoSeedGraph(
  bowtie: { simulated: boolean; created_by?: string },
  threats: readonly { simulated: boolean; created_by: string }[],
  consequences: readonly { simulated: boolean; created_by: string }[],
  groups: readonly { simulated: boolean; created_by: string }[],
  paths: readonly {
    path_simulated: boolean; path_created_by: string;
    barrier_simulated: boolean; barrier_created_by: string;
  }[],
): boolean {
  return Boolean(bowtie.created_by && isDemoSeedRecord({ simulated: bowtie.simulated, created_by: bowtie.created_by }))
    && threats.length > 0 && threats.every(isDemoSeedRecord)
    && consequences.length > 0 && consequences.every(isDemoSeedRecord)
    && groups.every(isDemoSeedRecord)
    && paths.length > 0 && paths.every((path) => isDemoSeedRecord({ simulated: path.path_simulated, created_by: path.path_created_by })
      && isDemoSeedRecord({ simulated: path.barrier_simulated, created_by: path.barrier_created_by }));
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
  try {
    validateRiskMatrix(input.matrix);
  } catch (error) {
    if (error instanceof RiskInputError) throw new RiskServiceError(409, "risk_matrix_invalid");
    throw error;
  }
  try {
    return calculateRisk(input);
  } catch (error) {
    if (error instanceof RiskInputError) throw new RiskServiceError(409, "risk_input_invalid");
    throw error;
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
  const match = /^(?:(\d+) years?(?: |$))?(?:(\d+) mons?(?: |$))?(?:(\d+) days?(?: |$))?(?:(\d+):(\d+):(\d+(?:\.\d+)?))?$/.exec(value.trim());
  if (!match || match.slice(1).every((part) => part === undefined)) throw new RiskServiceError(503, "risk_input_invalid");
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

function diffRiskInputs(previous: StoredInput, current: StoredInput): RiskInputChange[] {
  const changes: RiskInputChange[] = [];
  const compare = (before: unknown, after: unknown, path: string): void => {
    if (before === undefined || after === undefined) {
      if (before !== after) changes.push({ path, beforeValue: displayInputValue(before), afterValue: displayInputValue(after) });
      return;
    }
    if (canonicalJson(before) === canonicalJson(after)) return;
    if (Array.isArray(before) && Array.isArray(after)) {
      const isIdCollection = [...before, ...after].every((item) => item && typeof item === "object"
        && !Array.isArray(item) && typeof (item as Record<string, unknown>).id === "string");
      if (isIdCollection) {
        const beforeById = new Map(before.map((item) => [(item as { id: string }).id, item]));
        const afterById = new Map(after.map((item) => [(item as { id: string }).id, item]));
        for (const id of [...new Set([...beforeById.keys(), ...afterById.keys()])].sort()) {
          const prior = beforeById.get(id);
          const next = afterById.get(id);
          const itemPath = `${path}/${id}`;
          if (prior === undefined || next === undefined) {
            changes.push({ path: itemPath, beforeValue: displayInputValue(prior), afterValue: displayInputValue(next) });
          } else compare(prior, next, itemPath);
        }
        return;
      }
      for (let index = 0; index < Math.max(before.length, after.length); index++) {
        compare(before[index], after[index], `${path}/${index}`);
      }
      return;
    }
    if (before && after && typeof before === "object" && typeof after === "object") {
      const beforeObject = before as Record<string, unknown>;
      const afterObject = after as Record<string, unknown>;
      for (const key of [...new Set([...Object.keys(beforeObject), ...Object.keys(afterObject)])].sort()) {
        if (!path && key === "barriers") {
          const beforeIds = new Set((beforeObject[key] as RiskInput["barriers"]).map((item) => item.id));
          const afterIds = new Set((afterObject[key] as RiskInput["barriers"]).map((item) => item.id));
          for (const id of [...new Set([...beforeIds, ...afterIds])].sort()) {
            if (beforeIds.has(id) !== afterIds.has(id)) {
              const prior = (beforeObject[key] as RiskInput["barriers"]).find((item) => item.id === id);
              const next = (afterObject[key] as RiskInput["barriers"]).find((item) => item.id === id);
              changes.push({ path: `riskInput/barriers/${id}`, beforeValue: displayInputValue(prior), afterValue: displayInputValue(next) });
            }
          }
          continue;
        }
        compare(beforeObject[key], afterObject[key], path ? `${path}/${key}` : `riskInput/${key}`);
      }
      return;
    }
    changes.push({ path, beforeValue: displayInputValue(before), afterValue: displayInputValue(after) });
  };

  compare(previous.input, current.input, "");
  compare(previous.evidenceByBarrier, current.evidenceByBarrier, "evidenceByBarrier");
  compare(previous.calibration, current.calibration, "calibration");
  return changes;
}

function displayInputValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : canonicalJson(value);
}

function snapshotEnvelope(row: Record<string, unknown>): RiskSnapshotEnvelope {
  const stored = row.input_json as StoredInput | null;
  if (!stored?.calibration) throw new RiskServiceError(503, "risk_snapshot_unavailable");
  return {
    id: String(row.id), createdAt: asIso(row.created_at), trigger: String(row.trigger ?? "initial"),
    calibration: stored.calibration, snapshot: row.snapshot_json as RiskSnapshot,
  };
}

function readCalibration(organisation: Record<string, unknown>): RiskCalibration | null {
  const standardRef = typeof organisation.risk_matrix_standard_ref === "string" ? organisation.risk_matrix_standard_ref.trim() : "";
  const standardVersion = typeof organisation.risk_matrix_standard_version === "string" ? organisation.risk_matrix_standard_version.trim() : "";
  const approvedBy = typeof organisation.risk_matrix_approved_by === "string" ? organisation.risk_matrix_approved_by.trim() : "";
  const approvedAtValue = organisation.risk_matrix_approved_at;
  const approvedAt = approvedAtValue instanceof Date ? approvedAtValue : new Date(String(approvedAtValue ?? ""));
  if (!standardRef || !standardVersion || !approvedBy || !Number.isFinite(approvedAt.getTime())) return null;
  return { standardRef, standardVersion, approvedBy, approvedAt: approvedAt.toISOString() };
}
