import { randomUUID } from "node:crypto";
import { insertWorkerEventOutbox, lockWorkerEventOutbox, workerEventOutboxRow } from "@fieldloop/adapters";
import type { WorkerEvent } from "@fieldloop/contracts";
import { sql, type Kysely } from "kysely";
import { classificationRank, IdempotencyKeyReusedError, isClassification, type GuardrailPolicy, type GuardrailStore, type GuardrailSystem, type ModelRoute, type RecordContentScanInput, type RecordInterceptInput, type StoredContentScan } from "./model.js";

type Database = Record<string, never>;
type Classification = GuardrailSystem["classification"];

interface PolicyRow {
  ai_system_id: string;
  ai_system_code: string;
  org_id: string;
  ai_system_classification: string;
  data_classes: unknown;
  simulated: boolean;
  policy_id: string;
  barrier_id: string | null;
  policy_config: unknown;
  mode: string | null;
  fail_mode: string | null;
}

interface ContentScanRow {
  request_hash: string;
  status_code: number;
  decision: StoredContentScan["decision"];
  detected_classification: string;
  reason: string;
  policy_id: string;
  intercept_id: string;
}

export class UnknownGuardrailSystemError extends Error {
  constructor() {
    super("Registered AI System is unavailable");
    this.name = "UnknownGuardrailSystemError";
  }
}

export class PostgresGuardrailStore implements GuardrailStore {
  constructor(private readonly db: Kysely<Database>) {}

  async loadSystem(code: string, orgId: string, simulated: boolean): Promise<GuardrailSystem> {
    const rows = (await sql<PolicyRow>`SELECT s.id::text AS ai_system_id, ${code}::text AS ai_system_code,
        s.org_id, s.classification AS ai_system_classification, s.data_classes, s.simulated,
        p.id::text AS policy_id, p.barrier_id::text, p.config AS policy_config, p.mode, p.fail_mode
      FROM app.ai_system s
      JOIN app.guardrail_policy p ON p.ai_system_id = s.id AND p.org_id = s.org_id AND p.simulated = s.simulated
      WHERE s.org_id = ${orgId} AND s.simulated = ${simulated}
        AND p.config->>'aiSystemCode' = ${code}
      ORDER BY p.created_at, p.id`.execute(this.db)).rows;
    if (rows.length === 0) throw new UnknownGuardrailSystemError();

    const first = rows[0];
    if (!first || !isClassification(first.ai_system_classification)) throw new Error("AI System classification is invalid");
    const policies = rows.map(toPolicy);
    const routes = parseRoutes(policies[0]?.config["modelRoutes"]);
    if (policies.some((policy) => !policy.barrierId || policy.failMode !== "fail-closed")) {
      throw new Error("Guardrail policy is missing its Technical Barrier or fail-closed setting");
    }
    const dataClasses = parseClassifications(first.data_classes);
    if (dataClasses.length === 0) throw new Error("AI System has no registered data classes");
    if (rows.some((row) => row.ai_system_id !== first.ai_system_id || row.org_id !== first.org_id)) {
      throw new Error("AI System policy configuration is ambiguous");
    }
    return {
      id: first.ai_system_id,
      code,
      orgId: first.org_id,
      simulated: first.simulated,
      classification: first.ai_system_classification,
      dataClasses,
      modelRoutes: routes,
      policies,
    };
  }

  async recordIntercept(input: RecordInterceptInput): Promise<string> {
    return this.db.transaction().execute(async (trx) => {
      const rows = interceptRecordRows(input);
      await lockWorkerEventOutbox(trx, input.system.orgId);
      await sql`WITH ${interceptRecordInserts([rows])} SELECT 1`.execute(trx);
      return rows.interceptId;
    });
  }

  async getContentScan(orgId: string, idempotencyKeyHash: string): Promise<StoredContentScan | null> {
    const row = (await sql<ContentScanRow>`SELECT request_hash, status_code, decision, detected_classification,
        reason, policy_id::text, intercept_id::text
      FROM app.guardrail_content_request
      WHERE org_id = ${orgId} AND idempotency_key_hash = ${idempotencyKeyHash}`.execute(this.db)).rows[0];
    return row ? toStoredContentScan(row) : null;
  }

  async recordContentScan(input: RecordContentScanInput): Promise<StoredContentScan> {
    const primaryRecord = input.records[input.primaryRecordIndex];
    if (!primaryRecord || !primaryRecord.policy.barrierId || primaryRecord.policy.id !== input.result.policyId) {
      throw new Error("Content scan result must map to one recorded Guardrail Policy");
    }
    // Six round trips: BEGIN, the idempotency lock, the idempotency read, the outbox lock, one statement
    // that writes every Intercept, Evidence and outbox row plus the content-scan record, and COMMIT.
    return this.db.transaction().execute(async (trx) => {
      const orgId = input.system.orgId;
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([orgId, "guardrail_content_request", input.idempotencyKeyHash])}, 0))`.execute(trx);
      const previous = (await sql<ContentScanRow>`SELECT request_hash, status_code, decision, detected_classification,
          reason, policy_id::text, intercept_id::text
        FROM app.guardrail_content_request
        WHERE org_id = ${orgId} AND idempotency_key_hash = ${input.idempotencyKeyHash}`.execute(trx)).rows[0];
      if (previous) {
        const stored = toStoredContentScan(previous);
        if (stored.requestHash !== input.requestHash) throw new IdempotencyKeyReusedError();
        return stored;
      }

      const rows = input.records.map(interceptRecordRows);
      const interceptId = rows[input.primaryRecordIndex]?.interceptId;
      if (!interceptId) throw new Error("Content scan did not produce its primary Intercept");
      await lockWorkerEventOutbox(trx, orgId);
      await sql`WITH ${interceptRecordInserts(rows)}
        INSERT INTO app.guardrail_content_request
          (org_id, idempotency_key_hash, request_hash, status_code, decision, policy_id, intercept_id,
            detected_classification, reason, simulated, classification, created_by, created_at)
        VALUES (${orgId}, ${input.idempotencyKeyHash}, ${input.requestHash}, ${input.result.statusCode},
          ${input.result.decision}, ${input.result.policyId}::uuid, ${interceptId}::uuid,
          ${input.result.classification}, ${input.result.reason}, ${input.system.simulated},
          ${input.result.classification}, 'guardrail', clock_timestamp())`.execute(trx);
      return { requestHash: input.requestHash, ...input.result, interceptId };
    });
  }
}

/** The rows one Intercept writes: the Intercept, its Bowtie C Evidence and the evidence.created outbox event. */
function interceptRecordRows(input: RecordInterceptInput) {
  if (!input.policy.barrierId) throw new Error("Guardrail Policy has no mapped Technical Barrier");
  const interceptId = randomUUID();
  const evidenceId = randomUUID();
  const createdBy = "guardrail";
  const event: WorkerEvent = {
    id: randomUUID(),
    type: "evidence.created",
    orgId: input.system.orgId,
    entityId: evidenceId,
    barrierId: input.policy.barrierId,
    simulated: input.system.simulated,
    classification: input.classification,
  };
  return {
    interceptId,
    intercept: sql`(${interceptId}::uuid, ${input.system.orgId}, ${input.policy.id}::uuid, ${input.system.id}::uuid,
      ${input.decision}, ${input.reason}, ${input.latencyMs}, ${input.system.simulated},
      ${input.classification}, ${createdBy}, clock_timestamp())`,
    evidence: sql`(${evidenceId}::uuid, ${input.system.orgId}, ${input.policy.barrierId}::uuid,
      'guardrail.intercept', 'guardrail', clock_timestamp(), ${input.system.simulated},
      ${input.classification}, ${createdBy}, clock_timestamp())`,
    outbox: workerEventOutboxRow(event, createdBy),
  };
}

/** Data-modifying CTEs that insert the given Intercept rows; the caller holds the outbox lock. */
function interceptRecordInserts(rows: ReturnType<typeof interceptRecordRows>[]) {
  return sql`intercepts AS (
      INSERT INTO app.intercept
        (id, org_id, policy_id, ai_system_id, decision, reason, latency_ms, simulated, classification, created_by, created_at)
      VALUES ${sql.join(rows.map((row) => row.intercept))}
    ), evidence AS (
      INSERT INTO app.evidence
        (id, org_id, barrier_id, kind, source, observed_at, simulated, classification, created_by, created_at)
      VALUES ${sql.join(rows.map((row) => row.evidence))}
    ), outbox AS (
      ${insertWorkerEventOutbox(rows.map((row) => row.outbox))}
    )`;
}

function toStoredContentScan(row: ContentScanRow): StoredContentScan {
  if (!isClassification(row.detected_classification)) throw new Error("Stored content scan classification is invalid");
  return {
    requestHash: row.request_hash,
    statusCode: Number(row.status_code),
    decision: row.decision,
    classification: row.detected_classification,
    reason: row.reason,
    policyId: row.policy_id,
    interceptId: row.intercept_id,
  };
}

function toPolicy(row: PolicyRow): GuardrailPolicy {
  const config = asRecord(row.policy_config);
  if (!config || typeof config["id"] !== "string" || typeof config["kind"] !== "string") {
    throw new Error("Guardrail Policy configuration is invalid");
  }
  if (row.mode !== "enforce" && row.mode !== "monitor") throw new Error("Guardrail Policy mode is invalid");
  return {
    id: row.policy_id,
    code: config["id"],
    barrierId: row.barrier_id ?? "",
    kind: config["kind"],
    mode: row.mode,
    failMode: row.fail_mode ?? "",
    config,
  };
}

function parseClassifications(value: unknown): Classification[] {
  const entries = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(entries)) return [];
  return [...new Set(entries.filter(isClassification))].sort((left, right) => classificationRank(left) - classificationRank(right));
}

function parseRoutes(value: unknown): ModelRoute[] {
  if (!Array.isArray(value)) throw new Error("AI System model routes are missing");
  return value.map((entry) => {
    const route = asRecord(entry);
    if (!route || typeof route["tier"] !== "string" || typeof route["enabled"] !== "boolean"
      || typeof route["boundary"] !== "string" || typeof route["modelClass"] !== "string") {
      throw new Error("AI System model route is invalid");
    }
    return { tier: route["tier"], enabled: route["enabled"], boundary: route["boundary"], modelClass: route["modelClass"] };
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try { return asRecord(JSON.parse(value) as unknown); }
    catch { return null; }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
