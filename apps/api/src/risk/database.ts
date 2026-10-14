import type { ColumnType, Generated } from "kysely";
import { Kysely, PostgresDialect } from "kysely";
import type { Pool } from "pg";

type JsonColumn = ColumnType<unknown, unknown, unknown>;
type Timestamp = Date | string;

interface BowtieTable {
  id: string;
  org_id: string;
  hazard: string;
  top_event: string;
  domain: string | null;
  status: string | null;
  simulated: boolean;
  classification: string;
}

interface OrganisationTable {
  id: string;
  org_id: string;
  risk_matrix: JsonColumn | null;
  risk_severity_criteria: JsonColumn | null;
  risk_matrix_approved_at: Timestamp | null;
  risk_matrix_approved_by: string | null;
  risk_matrix_standard_ref: string | null;
  risk_matrix_standard_version: string | null;
  classification: string;
}

interface ThreatTable {
  id: string;
  org_id: string;
  bowtie_id: string;
  name: string | null;
  frequency_per_year: number | string;
  classification: string;
}

interface ConsequenceTable {
  id: string;
  org_id: string;
  bowtie_id: string;
  name: string | null;
  severity: JsonColumn;
  p_conditional: number | string;
  classification: string;
}

interface BarrierTable {
  id: string;
  org_id: string;
  name: string | null;
  type: string;
  side: string;
  health: string;
  pfd_band: number | string;
  classification: string;
  independence_group_id: string | null;
  evidence_interval: string | null;
}

interface BarrierPathTable {
  id: string;
  org_id: string;
  position: number;
  threat_id: string | null;
  consequence_id: string | null;
  barrier_id: string;
  classification: string;
}

interface DegradationFactorTable {
  id: string;
  org_id: string;
  barrier_id: string;
  description: string;
  classification: string;
}

interface IndependenceGroupTable {
  id: string;
  org_id: string;
  bowtie_id: string;
  classification: string;
}

interface HealthChangeTable {
  id: string;
  org_id: string;
  barrier_id: string;
  actor: string;
  reason: string;
  from_health: string | null;
  to_health: string;
  created_at: Timestamp;
  simulated: boolean;
  classification: string;
}

interface EvidenceTable {
  id: string;
  org_id: string;
  barrier_id: string;
  kind: string;
  source: string;
  observed_at: Timestamp;
  simulated: boolean;
  classification: string;
}

interface RiskSnapshotTable {
  id: Generated<string>;
  org_id: string;
  bowtie_id: string;
  top_event_freq: number;
  per_consequence_cells: JsonColumn;
  trigger: string;
  simulated: boolean;
  classification: string;
  created_by: string;
  snapshot_json: JsonColumn;
  input_json: JsonColumn;
  health_change_id: string | null;
  simulation_run_id: string | null;
  input_fingerprint: string | null;
  simulation_retired_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

interface SimulationWorkspaceTable {
  org_id: string;
  active_run_id: string | null;
}

export interface RiskDatabase {
  bowtie: BowtieTable;
  organisation: OrganisationTable;
  threat: ThreatTable;
  consequence: ConsequenceTable;
  barrier: BarrierTable;
  barrier_path: BarrierPathTable;
  degradation_factor: DegradationFactorTable;
  independence_group: IndependenceGroupTable;
  health_change: HealthChangeTable;
  evidence: EvidenceTable;
  risk_snapshot: RiskSnapshotTable;
  simulation_workspace: SimulationWorkspaceTable;
}

export function createRiskDatabase(pool: Pool): Kysely<RiskDatabase> {
  return new Kysely<RiskDatabase>({ dialect: new PostgresDialect({ pool }) });
}
