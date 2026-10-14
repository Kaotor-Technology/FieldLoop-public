import { createHash } from "node:crypto";
import { appendAuditEvent } from "@fieldloop/adapters";
import { sql, type Kysely, type Transaction } from "kysely";
import type { AuthDatabase } from "../auth/postgres-store.js";
import {
  GeoReferenceServiceError,
  type GeoReferenceCandidate,
  type GeoReferenceCreateResult,
  type GeoReferenceDecision,
  type GeoReferenceItem,
  type GeoReferenceKind,
  type GeoReferencePage,
  type GeoReferenceStore,
  type GeoScope,
  type GeoSourceDocument,
  type AssistantGeoIdentity,
} from "./model.js";

type Db = Kysely<AuthDatabase>;
type Connection = Db | Transaction<AuthDatabase>;
const CLASSIFICATIONS = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED"] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDP_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
const MAX_SOURCE_CHARS = 100_000;
const MAX_SOURCE_CHUNKS = 1_000;

interface DocumentRow {
  id: string;
  title: string;
  folder: string | null;
  simulated: boolean;
  classification: string;
}

interface ChunkRow {
  content: string | null;
  simulated: boolean;
  classification: string;
}

interface GeoReferenceRow {
  id: string;
  document_id: string;
  document_title: string;
  kind: string;
  geometry: string | Record<string, unknown> | null;
  chainage_from: number | string | null;
  chainage_to: number | string | null;
  proposed_label: string | null;
  source_snippet: string;
  confidence: number | string;
  target_asset_id: string | null;
  status: string;
  simulated: boolean;
  classification: string;
  created_at: string | Date;
  simulation_run_id?: string | null;
  decision_key?: string | null;
  decision_hash?: string | null;
  decided_by?: string | null;
}

export class PostgresGeoReferenceStore implements GeoReferenceStore {
  constructor(private readonly db: Db) {}

  async getSource(documentId: string, scope: GeoScope): Promise<GeoSourceDocument> {
    return readSource(this.db, documentId, scope);
  }

  async createDrafts(input: {
    documentId: string;
    scope: AssistantGeoIdentity;
    idempotencyKey: string;
    references: GeoReferenceCandidate[];
  }): Promise<GeoReferenceCreateResult> {
    if (!IDP_KEY_PATTERN.test(input.idempotencyKey) || input.references.length > 50) {
      throw new GeoReferenceServiceError(400, "validation_failed");
    }
    return this.db.transaction().execute(async (trx) => {
      const source = await readSource(trx, input.documentId, input.scope);
      if (source.simulated) {
        const activeRun = (await sql<{ active_run_id: string | null }>`
          SELECT active_run_id::text FROM app.simulation_workspace WHERE org_id = ${input.scope.orgId}
        `.execute(trx)).rows[0]?.active_run_id;
        if (!activeRun) throw new GeoReferenceServiceError(409, "simulation_run_unavailable");
        await sql`SELECT set_config('app.simulation_run_id', ${activeRun}, true)`.execute(trx);
      }
      const references = input.references.map((candidate) => validateCandidate(candidate, source));
      const keyPrefix = digest(input.idempotencyKey).slice(0, 48);
      const extractionKeys = references.map((_candidate, index) => `${keyPrefix}:${index}`);
      const extractionHash = digest(JSON.stringify(references));
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([input.scope.orgId, input.documentId, keyPrefix])}, 0))`.execute(trx);

      if (extractionKeys.length > 0) {
        const previous = (await sql<{ extraction_key: string; extraction_hash: string; id: string }>`
          SELECT extraction_key, extraction_hash, id::text
          FROM app.geo_reference
          WHERE org_id = ${input.scope.orgId} AND source_document_id = ${input.documentId}::uuid
            AND extraction_key = ANY(${extractionKeys}::text[])
          ORDER BY created_at, id
        `.execute(trx)).rows;
        if (previous.length > 0) {
          if (previous.length !== extractionKeys.length || previous.some((row) => row.extraction_hash !== extractionHash)) {
            throw new GeoReferenceServiceError(409, "idempotency_key_reused");
          }
          return { references: await loadReferences(trx, previous.map((row) => row.id), input.scope), replayed: true };
        }
      }

      const ids: string[] = [];
      for (let index = 0; index < references.length; index += 1) {
        const candidate = references[index];
        if (!candidate) continue;
        const kind = candidate.latitude !== null ? "point"
          : candidate.chainageFrom !== null ? "chainage" : "asset";
        const label = candidate.placeName ?? candidate.assetCode;
        const row = (await sql<{ id: string }>`
          INSERT INTO app.geo_reference
            (org_id, evidence_id, target_type, target_id, kind, geom, chainage_from, chainage_to,
             status, confidence, simulated, classification, created_by, source_document_id,
             source_snippet, proposed_label, extraction_key, extraction_hash)
          VALUES
            (${input.scope.orgId}, NULL, NULL, NULL, ${kind},
             CASE WHEN ${candidate.latitude}::numeric IS NULL THEN NULL
               ELSE ST_SetSRID(ST_MakePoint(${candidate.longitude}::numeric, ${candidate.latitude}::numeric), 4326) END,
             ${candidate.chainageFrom}, ${candidate.chainageTo}, 'draft', ${candidate.confidence},
             ${source.simulated}, ${source.classification}, ${input.scope.sub}, ${input.documentId}::uuid,
             ${candidate.sourceSnippet}, ${label ?? null}, ${extractionKeys[index] ?? `${keyPrefix}:${index}`}, ${extractionHash})
          RETURNING id::text
        `.execute(trx)).rows[0];
        if (row) ids.push(row.id);
      }
      return { references: await loadReferences(trx, ids, input.scope), replayed: false };
    });
  }

  async listDrafts(scope: GeoScope, cursor: string | undefined, limit: number): Promise<GeoReferencePage> {
    const position = cursor ? decodeCursor(cursor) : null;
    const clearanceRank = classificationRank(scope.clearance);
    const after = position
      ? sql`AND (gr.created_at, gr.id) < (${position.createdAt}::timestamptz, ${position.id}::uuid)`
      : sql``;
    const rows = (await sql<GeoReferenceRow>`
      SELECT gr.id::text, gr.source_document_id::text AS document_id, d.title AS document_title,
             gr.kind, CASE WHEN gr.geom IS NULL THEN NULL ELSE ST_AsGeoJSON(gr.geom)::jsonb END AS geometry,
             gr.chainage_from, gr.chainage_to, gr.proposed_label, gr.source_snippet, gr.confidence,
             CASE WHEN gr.target_type = 'asset' THEN gr.target_id::text ELSE NULL END AS target_asset_id,
             gr.status, gr.simulated, gr.classification, gr.created_at
      FROM app.geo_reference gr
      JOIN app.controlled_document d ON d.org_id = gr.org_id AND d.id = gr.source_document_id
      WHERE gr.org_id = ${scope.orgId} AND gr.status = 'draft'
        AND gr.source_document_id IS NOT NULL AND gr.simulation_retired_at IS NULL
        AND d.status = 'current' AND d.superseded_by IS NULL
        AND array_position(ARRAY['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED']::text[], gr.classification) <= ${clearanceRank + 1}
        AND array_position(ARRAY['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED']::text[], d.classification) <= ${clearanceRank + 1}
        ${after}
      ORDER BY gr.created_at DESC, gr.id DESC
      LIMIT ${limit + 1}
    `.execute(this.db)).rows;
    const pageRows = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(toGeoReference),
      limit,
      nextCursor: hasMore && last ? encodeCursor({ createdAt: dateString(last.created_at), id: last.id }) : null,
    };
  }

  async decide(input: {
    scope: GeoScope;
    geoReferenceId: string;
    decision: GeoReferenceDecision;
    targetAssetId?: string;
    idempotencyKey: string;
  }): Promise<GeoReferenceItem> {
    if (!IDP_KEY_PATTERN.test(input.idempotencyKey)) throw new GeoReferenceServiceError(400, "validation_failed");
    const key = digest(input.idempotencyKey);
    const bodyHash = digest(JSON.stringify([input.geoReferenceId, input.decision, input.targetAssetId ?? null]));
    const classificationRankValue = classificationRank(input.scope.clearance);
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([input.scope.orgId, input.scope.sub, key])}, 0))`.execute(trx);
      const previous = (await sql<{ id: string; decision_hash: string }>`
        SELECT id::text, decision_hash FROM app.geo_reference
        WHERE org_id = ${input.scope.orgId} AND decided_by = ${input.scope.sub} AND decision_key = ${key}
      `.execute(trx)).rows[0];
      if (previous) {
        if (previous.id !== input.geoReferenceId || previous.decision_hash !== bodyHash) {
          throw new GeoReferenceServiceError(409, "idempotency_key_reused");
        }
        return (await loadReferences(trx, [previous.id], input.scope))[0] as GeoReferenceItem;
      }

      const row = (await sql<GeoReferenceRow>`
        SELECT gr.id::text, gr.source_document_id::text AS document_id, d.title AS document_title,
               gr.kind, CASE WHEN gr.geom IS NULL THEN NULL ELSE ST_AsGeoJSON(gr.geom)::jsonb END AS geometry,
               gr.chainage_from, gr.chainage_to, gr.proposed_label, gr.source_snippet, gr.confidence,
               CASE WHEN gr.target_type = 'asset' THEN gr.target_id::text ELSE NULL END AS target_asset_id,
               gr.status, gr.simulated, gr.classification, gr.created_at, gr.simulation_run_id::text,
               gr.decision_key, gr.decision_hash, gr.decided_by
        FROM app.geo_reference gr
        JOIN app.controlled_document d ON d.org_id = gr.org_id AND d.id = gr.source_document_id
        WHERE gr.org_id = ${input.scope.orgId} AND gr.id = ${input.geoReferenceId}::uuid
          AND gr.source_document_id IS NOT NULL AND gr.simulation_retired_at IS NULL
          AND d.status = 'current' AND d.superseded_by IS NULL
          AND array_position(ARRAY['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED']::text[], gr.classification) <= ${classificationRankValue + 1}
          AND array_position(ARRAY['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED']::text[], d.classification) <= ${classificationRankValue + 1}
        FOR UPDATE OF gr
      `.execute(trx)).rows[0];
      if (!row) throw new GeoReferenceServiceError(404, "not_found");
      if (row.status !== "draft") throw new GeoReferenceServiceError(409, "conflict");
      if (row.simulated && row.simulation_run_id) {
        await sql`SELECT set_config('app.simulation_run_id', ${row.simulation_run_id}, true)`.execute(trx);
      }

      let geometry = row.geometry;
      if (input.decision === "confirm" && input.targetAssetId) {
        const asset = (await sql<{ type: string; geom: unknown }>`
          SELECT a.type, ST_AsGeoJSON(a.geom)::jsonb AS geom
          FROM app.asset a
          WHERE a.org_id = ${input.scope.orgId} AND a.id = ${input.targetAssetId}::uuid
            AND a.simulated = ${row.simulated} AND a.geom IS NOT NULL
            AND array_position(ARRAY['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED']::text[], a.classification) <= ${classificationRankValue + 1}
        `.execute(trx)).rows[0];
        if (!asset) throw new GeoReferenceServiceError(404, "not_found");
        if (row.kind === "chainage") {
          if (asset.type !== "linear") throw new GeoReferenceServiceError(409, "conflict");
          const point = (await sql<{ geometry: unknown }>`
            SELECT ST_AsGeoJSON(ST_LineInterpolatePoint(s.geom,
              ((${row.chainage_from}::numeric + COALESCE(${row.chainage_to}, ${row.chainage_from})::numeric) / 2 - s.chainage_from)
                / NULLIF(s.chainage_to - s.chainage_from, 0)))::jsonb AS geometry
            FROM app.segment s JOIN app.asset a ON a.org_id = s.org_id AND a.id = s.asset_id
            WHERE s.org_id = ${input.scope.orgId} AND s.asset_id = ${input.targetAssetId}::uuid
              AND s.simulated = ${row.simulated} AND a.simulated = ${row.simulated}
              AND s.geom IS NOT NULL AND s.chainage_from <= ${row.chainage_from}
              AND s.chainage_to >= COALESCE(${row.chainage_to}, ${row.chainage_from})
              AND array_position(ARRAY['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED']::text[], s.classification) <= ${classificationRankValue + 1}
              AND array_position(ARRAY['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED']::text[], a.classification) <= ${classificationRankValue + 1}
            ORDER BY s.chainage_from, s.id LIMIT 1
          `.execute(trx)).rows[0];
          if (!point?.geometry) throw new GeoReferenceServiceError(409, "conflict");
          geometry = point.geometry as GeoReferenceRow["geometry"];
        } else if (row.kind === "asset") {
          const point = (await sql<{ geometry: unknown }>`
            SELECT ST_AsGeoJSON(ST_PointOnSurface(a.geom))::jsonb AS geometry
            FROM app.asset a WHERE a.org_id = ${input.scope.orgId} AND a.id = ${input.targetAssetId}::uuid
              AND a.simulated = ${row.simulated} AND a.geom IS NOT NULL
          `.execute(trx)).rows[0];
          if (!point?.geometry) throw new GeoReferenceServiceError(409, "conflict");
          geometry = point.geometry as GeoReferenceRow["geometry"];
        }
      }
      if (input.decision === "confirm" && !geometry) throw new GeoReferenceServiceError(409, "conflict");

      const status = input.decision === "confirm" ? "confirmed" : "rejected";
      await sql`UPDATE app.geo_reference SET status = ${status},
        target_type = CASE WHEN ${input.targetAssetId ?? null}::uuid IS NULL THEN target_type ELSE 'asset' END,
        target_id = COALESCE(${input.targetAssetId ?? null}::uuid, target_id),
        geom = CASE WHEN ${input.decision} = 'confirm' AND ${input.targetAssetId ?? null}::uuid IS NOT NULL AND ${row.kind} IN ('chainage', 'asset')
          THEN ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geometry)}), 4326)
          ELSE geom END,
        decided_by = ${input.scope.sub}, decision_key = ${key}, decision_hash = ${bodyHash}
        WHERE org_id = ${input.scope.orgId} AND id = ${input.geoReferenceId}::uuid AND status = 'draft'`.execute(trx);

      await appendAuditEvent(trx, {
        orgId: input.scope.orgId,
        actor: input.scope.sub,
        action: `geo_reference.${status}`,
        entity: input.geoReferenceId,
        before: { status: "draft" },
        after: { status, targetAssetId: input.decision === "confirm" ? input.targetAssetId ?? null : null },
        simulated: row.simulated,
        classification: row.classification,
        createdBy: input.scope.sub,
      });
      const result = (await loadReferences(trx, [input.geoReferenceId], input.scope))[0];
      if (!result) throw new GeoReferenceServiceError(503, "service_unavailable");
      return result;
    });
  }
}

async function readSource(connection: Connection, documentId: string, scope: GeoScope): Promise<GeoSourceDocument> {
  if (!UUID_PATTERN.test(documentId)) throw new GeoReferenceServiceError(400, "validation_failed");
  const document = (await sql<DocumentRow>`
    SELECT id::text, title, folder, simulated, classification
    FROM app.controlled_document
    WHERE id = ${documentId}::uuid AND org_id = ${scope.orgId}
      AND status = 'current' AND superseded_by IS NULL
      AND array_position(ARRAY['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED']::text[], classification) <= ${classificationRank(scope.clearance) + 1}
  `.execute(connection)).rows[0];
  if (!document) throw new GeoReferenceServiceError(404, "not_found");
  const size = (await sql<{ chunk_count: string; total_chars: string }>`
    SELECT count(*)::text AS chunk_count, COALESCE(sum(char_length(c.content)), 0)::text AS total_chars
    FROM app.document_chunk c
    WHERE c.org_id = ${scope.orgId} AND c.document_id = ${documentId}::uuid
      AND c.simulated = ${document.simulated}
  `.execute(connection)).rows[0];
  if (size && (Number(size.chunk_count) > MAX_SOURCE_CHUNKS || Number(size.total_chars) > MAX_SOURCE_CHARS)) {
    throw new GeoReferenceServiceError(413, "payload_too_large");
  }
  const chunks = (await sql<ChunkRow>`
    SELECT c.content, c.simulated, c.classification
    FROM app.document_chunk c
    WHERE c.org_id = ${scope.orgId} AND c.document_id = ${documentId}::uuid
      AND c.simulated = ${document.simulated}
    ORDER BY c.page NULLS LAST, c.created_at, c.id
  `.execute(connection)).rows;
  if (chunks.some((chunk) => classificationRank(chunk.classification) > classificationRank(scope.clearance))) {
    throw new GeoReferenceServiceError(403, "forbidden");
  }
  const text = chunks.map((chunk) => chunk.content?.trim()).filter((content): content is string => Boolean(content)).join("\n\n");
  if (!text.trim()) throw new GeoReferenceServiceError(409, "source_unavailable");
  if (text.length > MAX_SOURCE_CHARS) throw new GeoReferenceServiceError(413, "payload_too_large");
  const classification = chunks.reduce((highest, chunk) =>
    classificationRank(chunk.classification) > classificationRank(highest) ? chunk.classification : highest, document.classification);
  return { id: document.id, title: document.title, folder: document.folder, text, simulated: document.simulated, classification };
}

function validateCandidate(candidate: GeoReferenceCandidate, source: GeoSourceDocument): GeoReferenceCandidate {
  const coordinatesPresent = candidate.latitude !== null || candidate.longitude !== null;
  if (coordinatesPresent !== (candidate.latitude !== null && candidate.longitude !== null)) {
    throw new GeoReferenceServiceError(400, "validation_failed");
  }
  if (candidate.latitude !== null && candidate.longitude !== null &&
      (!Number.isFinite(candidate.latitude) || candidate.latitude < -90 || candidate.latitude > 90 ||
       !Number.isFinite(candidate.longitude) || candidate.longitude < -180 || candidate.longitude > 180)) {
    throw new GeoReferenceServiceError(400, "validation_failed");
  }
  const chainagePresent = candidate.chainageFrom !== null || candidate.chainageTo !== null;
  if (candidate.chainageFrom !== null && (!Number.isFinite(candidate.chainageFrom) || candidate.chainageFrom < 0)) {
    throw new GeoReferenceServiceError(400, "validation_failed");
  }
  if (candidate.chainageTo !== null && (!Number.isFinite(candidate.chainageTo) || candidate.chainageTo < 0 ||
      candidate.chainageFrom === null || candidate.chainageTo < candidate.chainageFrom)) {
    throw new GeoReferenceServiceError(400, "validation_failed");
  }
  if (candidate.sourceSnippet.length < 1 || candidate.sourceSnippet.length > 1200 || !source.text.includes(candidate.sourceSnippet) ||
      !Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1 ||
      (!coordinatesPresent && !chainagePresent && !candidate.assetCode && !candidate.placeName)) {
    throw new GeoReferenceServiceError(400, "validation_failed");
  }
  return candidate;
}

async function loadReferences(connection: Connection, ids: string[], scope: GeoScope): Promise<GeoReferenceItem[]> {
  if (ids.length === 0) return [];
  const rows = (await sql<GeoReferenceRow>`
    SELECT gr.id::text, gr.source_document_id::text AS document_id, d.title AS document_title,
           gr.kind, CASE WHEN gr.geom IS NULL THEN NULL ELSE ST_AsGeoJSON(gr.geom)::jsonb END AS geometry,
           gr.chainage_from, gr.chainage_to, gr.proposed_label, gr.source_snippet, gr.confidence,
           CASE WHEN gr.target_type = 'asset' THEN gr.target_id::text ELSE NULL END AS target_asset_id,
           gr.status, gr.simulated, gr.classification, gr.created_at
    FROM app.geo_reference gr JOIN app.controlled_document d ON d.org_id = gr.org_id AND d.id = gr.source_document_id
    WHERE gr.org_id = ${scope.orgId} AND gr.id = ANY(${ids}::uuid[])
      AND gr.simulation_retired_at IS NULL
      AND array_position(ARRAY['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED']::text[], gr.classification) <= ${classificationRank(scope.clearance) + 1}
      AND array_position(ARRAY['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED']::text[], d.classification) <= ${classificationRank(scope.clearance) + 1}
    ORDER BY gr.created_at, gr.id
  `.execute(connection)).rows;
  const byId = new Map(rows.map((row) => [row.id, toGeoReference(row)]));
  return ids.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
}

function toGeoReference(row: GeoReferenceRow): GeoReferenceItem {
  const geometry = typeof row.geometry === "string" ? JSON.parse(row.geometry) as GeoReferenceItem["geometry"] : row.geometry as GeoReferenceItem["geometry"];
  if (row.kind !== "point" && row.kind !== "chainage" && row.kind !== "area" && row.kind !== "asset") {
    throw new Error("Database returned an unsupported Geo Reference kind");
  }
  if (row.status !== "draft" && row.status !== "confirmed" && row.status !== "rejected") {
    throw new Error("Database returned an unsupported Geo Reference status");
  }
  return {
    id: row.id,
    documentId: row.document_id,
    documentTitle: row.document_title,
    kind: row.kind as GeoReferenceKind,
    geometry,
    chainageFrom: numberOrNull(row.chainage_from),
    chainageTo: numberOrNull(row.chainage_to),
    proposedLabel: row.proposed_label,
    sourceSnippet: row.source_snippet,
    confidence: Number(row.confidence),
    targetAssetId: row.target_asset_id,
    status: row.status,
    simulated: row.simulated,
    classification: row.classification,
    createdAt: dateString(row.created_at),
  };
}

function numberOrNull(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

function classificationRank(value: string): number {
  return CLASSIFICATIONS.indexOf(value.toUpperCase() as (typeof CLASSIFICATIONS)[number]);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function encodeCursor(value: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeCursor(value: string): { createdAt: string; id: string } {
  try {
    if (value.length > 512) throw new Error("Too long");
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { createdAt?: unknown; id?: unknown };
    if (typeof decoded.createdAt !== "string" || Number.isNaN(Date.parse(decoded.createdAt)) ||
        typeof decoded.id !== "string" || !UUID_PATTERN.test(decoded.id)) throw new Error("Invalid cursor");
    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch {
    throw new GeoReferenceServiceError(400, "validation_failed");
  }
}

function dateString(value: string | Date): string {
  return new Date(value).toISOString();
}
