import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import { parseRegisteredSignalRule, isWorkerEvent, type RegisteredSignalRule, type Signal, type WorkerEvent } from "@fieldloop/contracts";
import { matchesRule, maximumClassification, streamKey } from "./rule-evaluator.js";
import { WorkerError, type WorkerStore } from "./model.js";

type Database = Record<string, never>;
type Connection = Kysely<Database> | Transaction<Database>;
interface RuleRow {
  id: string; pack: string; condition: unknown; targetBarrierSelector: unknown;
  simulated: boolean; classification: WorkerEvent["classification"];
}
interface Target { id: string; classification: WorkerEvent["classification"]; }
export type SourceInterval = number | { months: number };

export class PostgresWorkerStore implements WorkerStore {
  constructor(private readonly db: Kysely<Database>, private readonly orgId: string,
    private readonly expectedIntervals: Readonly<Record<string, SourceInterval>>, private readonly calendarTimeZone = "Asia/Bangkok") {}

  private interval(rule: RegisteredSignalRule): { seconds: number | null; months: number | null } {
    const interval = rule.condition.expectedIntervalMonths ? { months: rule.condition.expectedIntervalMonths }
      : rule.condition.expectedIntervalSeconds ?? this.expectedIntervals[rule.condition.source];
    if (interval && typeof interval === "object" && Number.isInteger(interval.months) && interval.months >= 1 && interval.months <= 12) {
      if (rule.condition.durationSeconds) throw new Error("Periodic calendar measurements cannot prove a continuous duration");
      return { seconds: null, months: interval.months };
    }
    if (typeof interval !== "number" || !Number.isInteger(interval) || interval < 1 || interval > 31_536_000) {
      throw new Error(`Expected measurement interval is required for ${rule.condition.source}`);
    }
    return { seconds: interval, months: null };
  }

  private async rules(connection: Connection, signal?: Signal): Promise<RegisteredSignalRule[]> {
    const filter = signal ? sql`AND condition->>'source' = ${signal.source} AND condition->>'tag' = ${signal.tag}` : sql``;
    const rows = (await sql<RuleRow>`SELECT id, pack, condition, target_barrier_selector AS "targetBarrierSelector", simulated, classification
      FROM app.signal_rule WHERE org_id = ${this.orgId} AND condition->>'kind' = 'signal' ${filter}
      ORDER BY id`.execute(connection)).rows;
    return rows.map(parseRegisteredSignalRule);
  }

  private async targets(connection: Connection, rule: RegisteredSignalRule, signal?: Signal): Promise<Target[]> {
    const selector = rule.targetBarrierSelector;
    const barrierFilter = signal?.barrierId ? sql`AND b.id = ${signal.barrierId}::uuid` : sql``;
    const assetFilter = signal?.assetId ? sql`AND EXISTS (
      SELECT 1 FROM app.asset a
      WHERE a.id = ${signal.assetId}::uuid AND a.org_id = b.org_id AND a.simulated = b.simulated
        AND a.domain_pack = ${rule.pack}
        AND (a.id IN (SELECT ba.asset_id FROM app.bowtie_asset ba WHERE ba.org_id = b.org_id AND ba.bowtie_id = bt.id)
          OR EXISTS (SELECT 1 FROM app.evidence e JOIN app.geo_reference g ON g.evidence_id = e.id AND g.org_id = e.org_id
            WHERE e.barrier_id = b.id AND e.org_id = b.org_id AND g.target_id = a.id AND g.status = 'confirmed'))
    )` : sql``;
    // Spatial conditions require an explicit, validated source location; do not guess from an untrusted payload.
    const location = signal?.payload?.["location"];
    const point = isLocation(location) ? sql`ST_SetSRID(ST_MakePoint(${location.coordinates[0]}, ${location.coordinates[1]}), 4326)` : sql`NULL::geometry`;
    const spatialFilter = signal ? sql`AND (r.spatial_geom IS NULL OR (r.spatial_geom && ${point} AND ST_Covers(r.spatial_geom, ${point})))` : sql``;
    return (await sql<Target>`SELECT DISTINCT b.id, b.classification
      FROM app.barrier b
      JOIN app.barrier_path bp ON bp.barrier_id = b.id AND bp.org_id = b.org_id
      LEFT JOIN app.threat t ON t.id = bp.threat_id AND t.org_id = b.org_id
      LEFT JOIN app.consequence c ON c.id = bp.consequence_id AND c.org_id = b.org_id
      JOIN app.bowtie bt ON bt.id = COALESCE(t.bowtie_id, c.bowtie_id) AND bt.org_id = b.org_id
      JOIN app.bowtie_asset ba ON ba.bowtie_id = bt.id AND ba.org_id = b.org_id
      JOIN app.asset a ON a.id = ba.asset_id AND a.org_id = b.org_id AND a.domain_pack = ${selector.pack}
      JOIN app.signal_rule r ON r.id = ${rule.id}::uuid AND r.org_id = b.org_id
      WHERE b.org_id = ${this.orgId} AND bt.code = ${selector.bowtieCode} AND b.code = ANY(${selector.barrierCodes}::text[])
        AND b.simulated = ${rule.simulated} AND bt.simulated = b.simulated AND a.simulated = b.simulated
        ${barrierFilter} ${assetFilter} ${spatialFilter}
      ORDER BY b.id`.execute(connection)).rows;
  }

  async initialize(): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const rules = await this.rules(trx);
      if (!rules.length) throw new Error("No registered Signal rules; FL-78 pack registration is required");
      for (const rule of rules) {
        const interval = this.interval(rule);
        const targets = await this.targets(trx, rule);
        if (!targets.length) throw new Error(`Unresolved Barrier selector for ${rule.condition.ruleId}; reload seeds with content codes`);
        for (const target of targets) {
          await sql`INSERT INTO app.signal_dependency (org_id, rule_id, barrier_id, expected_interval_seconds, expected_interval_months, simulated, classification, created_by)
            VALUES (${this.orgId}, ${rule.id}::uuid, ${target.id}::uuid, ${interval.seconds}, ${interval.months}, ${rule.simulated},
              ${maximumClassification(rule.classification, target.classification)}, 'signal-worker')
            ON CONFLICT (org_id, rule_id, barrier_id) DO UPDATE SET expected_interval_seconds = EXCLUDED.expected_interval_seconds,
              expected_interval_months = EXCLUDED.expected_interval_months,
              classification = CASE WHEN signal_dependency.classification = 'HIGHLY_RESTRICTED' THEN 'HIGHLY_RESTRICTED'
                WHEN signal_dependency.classification = 'CONFIDENTIAL' AND EXCLUDED.classification IN ('PUBLIC', 'INTERNAL') THEN 'CONFIDENTIAL'
                WHEN signal_dependency.classification = 'INTERNAL' AND EXCLUDED.classification = 'PUBLIC' THEN 'INTERNAL'
                ELSE EXCLUDED.classification END`.execute(trx);
        }
      }
    });
  }

  private async event(connection: Connection, type: WorkerEvent["type"], entityId: string, barrierId: string,
    simulated: boolean, classification: WorkerEvent["classification"]): Promise<void> {
    const event: WorkerEvent = { id: randomUUID(), type, orgId: this.orgId, entityId, barrierId, simulated, classification };
    await sql`INSERT INTO app.signal_event_outbox (id, org_id, event, simulated, classification, created_by)
      VALUES (${event.id}::uuid, ${this.orgId}, ${JSON.stringify(event)}::jsonb, ${simulated}, ${classification}, 'signal-worker')`.execute(connection);
  }

  async ingest(signal: Signal): Promise<void> {
    if (signal.orgId !== this.orgId) throw new WorkerError("Unexpected Organisation", 403);
    await this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([this.orgId, signal.id.toLowerCase()])}, 0))`.execute(trx);
      const previous = (await sql<{ same: boolean }>`SELECT content = ${JSON.stringify(signal)}::jsonb AS same
        FROM app.signal_receipt WHERE org_id = ${this.orgId} AND id = ${signal.id}::uuid`.execute(trx)).rows[0];
      if (previous) {
        if (!previous.same) throw new WorkerError("Signal identity reused with different content", 409);
        return;
      }
      const key = streamKey(signal);
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([this.orgId, key])}, 0))`.execute(trx);
      const saved = (await sql<{ id: string }>`INSERT INTO app.signal (org_id, source, tag, value, observed_at, payload, simulated, classification, created_by)
        VALUES (${this.orgId}, ${signal.source}, ${signal.tag}, ${typeof signal.value === "number" ? signal.value : null},
          ${signal.observedAt}::timestamptz, ${JSON.stringify(signal)}::jsonb, ${signal.simulated}, ${signal.classification}, 'signal-worker') RETURNING id`.execute(trx)).rows[0];
      if (!saved) throw new Error("Signal insert returned no identity");
      await sql`INSERT INTO app.signal_receipt (id, org_id, signal_id, observed_at, stream_key, content, simulated, classification, created_by)
        VALUES (${signal.id}::uuid, ${this.orgId}, ${saved.id}::bigint, ${signal.observedAt}::timestamptz, ${key},
          ${JSON.stringify(signal)}::jsonb, ${signal.simulated}, ${signal.classification}, 'signal-worker')`.execute(trx);
      const isFresh = !(await sql<{ id: string }>`SELECT id FROM app.signal_receipt
        WHERE org_id = ${this.orgId} AND stream_key = ${key} AND observed_at >= ${signal.observedAt}::timestamptz
          AND id <> ${signal.id}::uuid LIMIT 1`.execute(trx)).rows.length;
      for (const rule of await this.rules(trx, signal)) {
        if (signal.simulated !== rule.simulated || signal.unit !== rule.condition.unit
          || !(typeof signal.value === "number" || (typeof signal.value === "boolean" && rule.condition.unit === "boolean"))) continue;
        const interval = this.interval(rule);
        let matches: boolean;
        if (rule.condition.durationSeconds) {
          const from = new Date(Date.parse(signal.observedAt) - (rule.condition.durationSeconds + (interval.seconds ?? 0)) * 1000);
          const history = (await sql<{ content: Signal }>`SELECT content FROM app.signal_receipt
            WHERE org_id = ${this.orgId} AND stream_key = ${key} AND observed_at >= ${from} AND observed_at <= ${signal.observedAt}::timestamptz
            ORDER BY observed_at LIMIT 10001`.execute(trx)).rows;
          if (history.length > 10000) throw new Error("Duration history exceeds the supported observation budget");
          matches = matchesRule(rule, signal, history.map(({ content }) => content), interval.seconds ?? 0);
        } else matches = matchesRule(rule, signal, [], interval.seconds ?? 0);
        for (const target of await this.targets(trx, rule, signal)) {
          // Match Scheduler's lock order before Evidence's Barrier foreign-key lock.
          const dependency = (await sql<{ id: string }>`SELECT id FROM app.signal_dependency WHERE org_id = ${this.orgId} AND rule_id = ${rule.id}::uuid
            AND barrier_id = ${target.id}::uuid FOR UPDATE`.execute(trx)).rows[0];
          if (!dependency) throw new Error("Signal rule dependency is not initialized; restart the worker after pack registration");
          const classification = maximumClassification(signal.classification, rule.classification, target.classification);
          const evidence = (await sql<{ id: string }>`INSERT INTO app.evidence
            (org_id, barrier_id, kind, source, observed_at, simulated, classification, created_by, signal_receipt_id)
            VALUES (${this.orgId}, ${target.id}::uuid, 'observation', 'signal', ${signal.observedAt}::timestamptz,
              ${signal.simulated}, ${classification}, 'signal-worker', ${signal.id}::uuid)
            ON CONFLICT DO NOTHING RETURNING id`.execute(trx)).rows[0];
          if (evidence) await this.event(trx, "evidence.created", evidence.id, target.id, signal.simulated, classification);
          // Old observations remain history, but do not hide a silent source or raise stale proposals.
          const fresh = isFresh ? (await sql<{ id: string }>`UPDATE app.signal_dependency SET last_received_at = clock_timestamp(),
              classification = CASE WHEN classification = 'HIGHLY_RESTRICTED' OR ${classification} = 'HIGHLY_RESTRICTED' THEN 'HIGHLY_RESTRICTED'
                WHEN classification = 'CONFIDENTIAL' OR ${classification} = 'CONFIDENTIAL' THEN 'CONFIDENTIAL'
                WHEN classification = 'INTERNAL' OR ${classification} = 'INTERNAL' THEN 'INTERNAL' ELSE 'PUBLIC' END,
              last_observed_at = GREATEST(last_observed_at, ${signal.observedAt}::timestamptz)
            WHERE org_id = ${this.orgId} AND rule_id = ${rule.id}::uuid AND barrier_id = ${target.id}::uuid
              RETURNING id`.execute(trx)).rows[0] : undefined;
          if (!fresh || !matches) continue;
          const proposal = (await sql<{ id: string }>`INSERT INTO app.health_proposal
            (org_id, barrier_id, proposed_health, source_rule_id, signal_id, signal_receipt_id, status, reason, simulated, classification, created_by)
            VALUES (${this.orgId}, ${target.id}::uuid, ${rule.condition.effect.proposedHealth}, ${rule.id}::uuid, ${saved.id}::bigint,
              ${signal.id}::uuid, 'open', ${rule.condition.effect.reason}, ${signal.simulated}, ${classification}, 'signal-worker') RETURNING id`.execute(trx)).rows[0];
          if (!proposal) throw new Error("Proposal insert returned no identity");
          await this.event(trx, "health_proposal.created", proposal.id, target.id, signal.simulated, classification);
        }
      }
    });
  }

  async detectSilence(now: Date): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      // Lock dependencies first, just like ingest. Recheck under these locks so a fresh reading
      // racing the Scheduler cannot be overwritten by an old silence decision.
      const dependencies = (await sql<{ id: string; barrier_id: string; classification: WorkerEvent["classification"]; simulated: boolean }>`
        SELECT d.id, d.barrier_id, d.classification, d.simulated FROM app.signal_dependency d
        JOIN app.signal_rule r ON r.id = d.rule_id AND r.org_id = d.org_id
        WHERE d.org_id = ${this.orgId} AND r.condition->>'kind' = 'signal'
        ORDER BY d.rule_id, d.barrier_id FOR UPDATE OF d`.execute(trx)).rows;
      let count = 0;
      for (const dependency of dependencies) {
        const stale = (await sql<{ id: string }>`SELECT id FROM app.signal_dependency
          WHERE id = ${dependency.id}::uuid AND CASE WHEN expected_interval_months IS NOT NULL THEN
            ((COALESCE(last_received_at, created_at) AT TIME ZONE ${this.calendarTimeZone})
              + make_interval(months => expected_interval_months)) AT TIME ZONE ${this.calendarTimeZone}
            ELSE COALESCE(last_received_at, created_at) + expected_interval_seconds * INTERVAL '1 second' END < ${now}`.execute(trx)).rows[0];
        if (!stale) continue;
        const barrier = (await sql<{ health: string; classification: WorkerEvent["classification"] }>`SELECT health, classification FROM app.barrier
          WHERE org_id = ${this.orgId} AND id = ${dependency.barrier_id}::uuid AND simulated = ${dependency.simulated}
          FOR UPDATE`.execute(trx)).rows[0];
        if (!barrier || !["healthy", "degraded"].includes(barrier.health)) continue;
        const classification = maximumClassification(dependency.classification, barrier.classification);
        await sql`UPDATE app.barrier SET health = 'unverified' WHERE org_id = ${this.orgId} AND id = ${dependency.barrier_id}::uuid`.execute(trx);
        const reason = "Expected periodic Signal measurement was not received; source is silent";
        const change = (await sql<{ id: string }>`INSERT INTO app.health_change
          (org_id, barrier_id, from_health, to_health, reason, actor, simulated, classification, created_by)
          VALUES (${this.orgId}, ${dependency.barrier_id}::uuid, ${barrier.health}, 'unverified', ${reason}, 'ageing',
            ${dependency.simulated}, ${classification}, 'signal-worker') RETURNING id`.execute(trx)).rows[0];
        if (!change) throw new Error("Health change insert returned no identity");
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([this.orgId, "audit_event"])}, 0))`.execute(trx);
        const previous = (await sql<{ content: string }>`SELECT to_jsonb(a)::text AS content
          FROM app.audit_event a WHERE org_id = ${this.orgId} ORDER BY created_at DESC, id DESC LIMIT 1`.execute(trx)).rows[0];
        const previousHash = previous ? createHash("sha256").update(previous.content).digest("hex") : null;
        const hash = (health: string) => createHash("sha256").update(JSON.stringify({ barrierId: dependency.barrier_id, health })).digest("hex");
        await sql`INSERT INTO app.audit_event (org_id, actor, action, entity, before_hash, after_hash, prev_hash, simulated, classification, created_by, created_at)
          VALUES (${this.orgId}, 'signal-worker:ageing', 'barrier.health_changed', ${dependency.barrier_id}, ${hash(barrier.health)},
            ${hash("unverified")}, ${previousHash}, ${dependency.simulated}, ${classification}, 'signal-worker', clock_timestamp())`.execute(trx);
        await this.event(trx, "barrier.health_changed", change.id, dependency.barrier_id, dependency.simulated, classification);
        // No approval is fabricated. Failed stays Failed; receipt alone never restores Health.
        count++;
      }
      return count;
    });
  }

  async publishPending(publish: (event: WorkerEvent) => Promise<void>): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const rows = (await sql<{ id: string; event: unknown }>`SELECT id, event FROM app.signal_event_outbox
        WHERE org_id = ${this.orgId} AND published_at IS NULL ORDER BY created_at, id
        LIMIT 100 FOR UPDATE SKIP LOCKED`.execute(trx)).rows;
      for (const row of rows) {
        if (!isWorkerEvent(row.event)) throw new Error("Invalid worker outbox event");
        await publish(row.event);
        await sql`UPDATE app.signal_event_outbox SET published_at = clock_timestamp() WHERE id = ${row.id}::uuid AND org_id = ${this.orgId}`.execute(trx);
      }
    });
  }
}

function isLocation(value: unknown): value is { type: "Point"; coordinates: [number, number] } {
  if (!value || typeof value !== "object" || !("type" in value) || value.type !== "Point" || !("coordinates" in value)) return false;
  const coordinates = value.coordinates;
  return Array.isArray(coordinates) && coordinates.length === 2 && coordinates.every((item) => typeof item === "number" && Number.isFinite(item))
    && Math.abs(coordinates[0] as number) <= 180 && Math.abs(coordinates[1] as number) <= 90;
}
