import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { CurrentUser } from "../auth/service.js";
import { ImportError, parseUpload, type KmlPoint } from "./parser.js";

const CLASSIFICATION_ORDER = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED"];
export interface ImportMapping {
  assetId: string;
  toleranceMetres: number;
  nameField: string;
  descriptionField: string;
  categoryField: string;
  target: "evidence" | "facility";
  barrierId: string | null;
}
export interface PreviewPoint extends KmlPoint {
  id: string;
  distanceMetres: number | null;
  chainageMetres: number | null;
  flags: string[];
}
export interface ImportPreview {
  id: string;
  status: "preview" | "mapped" | "committed" | "rolled_back";
  version: number;
  classification: string;
  fileHash: string;
  createdAt: string;
  mapping: ImportMapping | null;
  points: PreviewPoint[];
}
interface ImportRow { id: string; status: ImportPreview["status"]; version: number; classification: string;
  file_hash: string; created_at: Date; preview: PreviewPoint[]; mapping: ImportMapping | null; commit_key: string | null; rollback_key: string | null; validation_hash: string | null }
export interface ImportPort {
  create(user: CurrentUser, bytes: Buffer, format: "kml" | "kmz", key: string): Promise<ImportPreview>;
  preview(user: CurrentUser, id: string): Promise<ImportPreview>;
  map(user: CurrentUser, id: string, version: number, mapping: ImportMapping): Promise<ImportPreview>;
  command(user: CurrentUser, id: string, version: number, command: "commit" | "rollback", key: string): Promise<ImportPreview>;
  options(user: CurrentUser): Promise<{ assets: { id: string; name: string }[]; barriers: { id: string; name: string; assetId: string }[] }>;
}
function allowed(user: CurrentUser): string[] { return CLASSIFICATION_ORDER.slice(0, CLASSIFICATION_ORDER.indexOf(user.clearance) + 1); }
function result(row: ImportRow): ImportPreview {
  return { id: row.id, status: row.status, version: row.version, classification: row.classification,
    fileHash: row.file_hash, createdAt: new Date(row.created_at).toISOString(), mapping: row.mapping, points: row.preview };
}
export class PostgresImportStore implements ImportPort {
  constructor(private readonly db: Kysely<Record<string, never>>) {}
  async options(user: CurrentUser, db = this.db) {
    const assets = await sql<{ id: string; name: string }>`SELECT a.id::text, COALESCE(a.attributes->>'name', a.id::text) AS name FROM app.asset a
      WHERE a.org_id = ${user.orgId} AND a.classification = ANY(${allowed(user)}::text[]) AND a.simulated IS TRUE
      AND EXISTS (SELECT 1 FROM app.segment s WHERE s.asset_id=a.id AND s.org_id=a.org_id AND s.classification=ANY(${allowed(user)}::text[]))`.execute(db);
    const barriers = await sql<{ id: string; name: string; assetId: string }>`SELECT DISTINCT b.id::text, COALESCE(b.name,b.id::text) AS name, ba.asset_id::text AS "assetId"
      FROM app.barrier b JOIN app.barrier_path bp ON bp.barrier_id=b.id AND bp.org_id=b.org_id
      LEFT JOIN app.threat t ON t.id=bp.threat_id AND t.org_id=b.org_id LEFT JOIN app.consequence c ON c.id=bp.consequence_id AND c.org_id=b.org_id
      JOIN app.bowtie_asset ba ON ba.bowtie_id=COALESCE(t.bowtie_id,c.bowtie_id) AND ba.org_id=b.org_id
      WHERE b.org_id=${user.orgId} AND b.simulated IS TRUE AND b.classification=ANY(${allowed(user)}::text[])
      AND bp.classification=ANY(${allowed(user)}::text[]) AND ba.classification=ANY(${allowed(user)}::text[])`.execute(db);
    return { assets: assets.rows, barriers: barriers.rows };
  }
  async create(user: CurrentUser, bytes: Buffer, format: "kml" | "kmz", key: string) {
    const hash = createHash("sha256").update(bytes).digest("hex");
    const points = (await parseUpload(bytes, format)).map((point) => ({ ...point, id: randomUUID(), distanceMetres: null, chainageMetres: null, flags: ["not_mapped"] }));
    const row = await this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${user.orgId + user.sub + key},0))`.execute(trx);
      const previous = await sql<ImportRow>`SELECT * FROM app.kml_import WHERE org_id=${user.orgId} AND created_by=${user.sub} AND request_key=${key}`.execute(trx);
      const existing = previous.rows[0];
      if (existing) {
        if (!allowed(user).includes(existing.classification)) throw new ImportError(403,"forbidden");
        if (existing.file_hash !== hash) throw new ImportError(409,"idempotency_key_reused"); return existing;
      }
      // Until an Asset is selected, uploaded geometry retains the highest class.
      if (!allowed(user).includes("HIGHLY_RESTRICTED")) throw new ImportError(403,"forbidden");
      const inserted = await sql<ImportRow>`INSERT INTO app.kml_import (org_id,file_hash,preview,status,simulated,classification,created_by,request_key)
        VALUES (${user.orgId},${hash},${JSON.stringify(points)}::jsonb,'preview',true,'HIGHLY_RESTRICTED',${user.sub},${key}) RETURNING *`.execute(trx);
      const saved = inserted.rows[0]; if (!saved) throw new ImportError(503,"service_unavailable");
      return saved;
    });
    return result(row);
  }
  private async read(db: Kysely<Record<string, never>>, user: CurrentUser, id: string, lock = false): Promise<ImportRow> {
    const rows = await sql<ImportRow>`SELECT * FROM app.kml_import WHERE id=${id}::uuid AND org_id=${user.orgId}
      AND created_by=${user.sub} AND classification=ANY(${allowed(user)}::text[]) ${lock ? sql`FOR UPDATE` : sql``}`.execute(db);
    const row = rows.rows[0]; if (!row) throw new ImportError(404,"not_found"); return row;
  }
  async preview(user: CurrentUser, id: string) { return result(await this.read(this.db,user,id)); }
  private async contextHash(db: Kysely<Record<string,never>>, user: CurrentUser, mapping: ImportMapping): Promise<string> {
    const row = (await sql<{ hash: string }>`SELECT md5(jsonb_build_object(
      'asset',(SELECT jsonb_build_object('geom',ST_AsEWKB(geom),'classification',classification,'simulated',simulated) FROM app.asset WHERE id=${mapping.assetId}::uuid AND org_id=${user.orgId}),
      'segments',(SELECT jsonb_agg(jsonb_build_object('id',id,'geom',ST_AsEWKB(geom),'classification',classification,'from',chainage_from,'to',chainage_to) ORDER BY id) FROM app.segment WHERE asset_id=${mapping.assetId}::uuid AND org_id=${user.orgId}),
      'area',(SELECT ST_AsEWKB(import_area) FROM app.organisation WHERE org_id=${user.orgId} LIMIT 1),
      'barrier',(SELECT jsonb_build_object('classification',classification,'simulated',simulated) FROM app.barrier WHERE id=${mapping.barrierId}::uuid AND org_id=${user.orgId}),
      'links',(SELECT jsonb_agg(to_jsonb(bp) ORDER BY bp.id) FROM app.barrier_path bp WHERE bp.barrier_id=${mapping.barrierId}::uuid AND bp.org_id=${user.orgId}),
      'bowtieAssets',(SELECT jsonb_agg(to_jsonb(ba) ORDER BY ba.bowtie_id,ba.asset_id) FROM app.bowtie_asset ba
        JOIN app.barrier_path bp ON bp.org_id=ba.org_id
        LEFT JOIN app.threat t ON t.id=bp.threat_id AND t.org_id=ba.org_id
        LEFT JOIN app.consequence c ON c.id=bp.consequence_id AND c.org_id=ba.org_id
        WHERE ba.org_id=${user.orgId} AND bp.barrier_id=${mapping.barrierId}::uuid AND ba.bowtie_id=COALESCE(t.bowtie_id,c.bowtie_id))
      )::text) AS hash`.execute(db)).rows[0];
    if (!row) throw new ImportError(503,"service_unavailable"); return row.hash;
  }
  async map(user: CurrentUser, id: string, version: number, mapping: ImportMapping) {
    return this.db.transaction().setIsolationLevel("repeatable read").execute(async (trx) => {
      const row = await this.read(trx,user,id,true);
      if (row.version !== version || !["preview","mapped"].includes(row.status)) throw new ImportError(409,"conflict");
      const asset = (await sql<{ classification: string }>`SELECT classification FROM app.asset WHERE id=${mapping.assetId}::uuid
        AND org_id=${user.orgId} AND simulated IS TRUE AND classification=ANY(${allowed(user)}::text[]) FOR SHARE`.execute(trx)).rows[0];
      if (!asset) throw new ImportError(404,"not_found");
      let classification = asset.classification;
      if (mapping.target === "evidence") {
        if (!mapping.barrierId) throw new ImportError(400,"barrier_required");
        const choices = await this.options(user,trx);
        if (!choices.barriers.some((barrier) => barrier.id === mapping.barrierId && barrier.assetId === mapping.assetId)) throw new ImportError(404,"not_found");
        const barrier = (await sql<{ classification: string }>`SELECT classification FROM app.barrier WHERE id=${mapping.barrierId}::uuid AND org_id=${user.orgId} FOR SHARE`.execute(trx)).rows[0];
        if (!barrier) throw new ImportError(404,"not_found");
        classification = CLASSIFICATION_ORDER[Math.max(CLASSIFICATION_ORDER.indexOf(classification), CLASSIFICATION_ORDER.indexOf(barrier.classification))] ?? "HIGHLY_RESTRICTED";
      }
      const fields = new Set(row.preview.flatMap((point) => Object.keys(point.attributes)));
      if (![mapping.nameField,mapping.descriptionField,mapping.categoryField].every((field) => !field || fields.has(field))) throw new ImportError(400,"invalid_mapping");
      const points: PreviewPoint[] = [];
      for (const point of row.preview) {
        const location = sql`ST_SetSRID(ST_MakePoint(${point.longitude},${point.latitude}),4326)`;
        const nearest = (await sql<{ distance: number; chainage: number; classification: string }>`SELECT ST_Distance(s.geom::geography,${location}::geography) AS distance,
          (s.chainage_from + ST_LineLocatePoint(s.geom,${location})*(s.chainage_to-s.chainage_from))::float8 AS chainage, s.classification
          FROM app.segment s WHERE s.asset_id=${mapping.assetId}::uuid AND s.org_id=${user.orgId} AND s.classification=ANY(${allowed(user)}::text[])
          AND s.chainage_from IS NOT NULL AND s.chainage_to IS NOT NULL ORDER BY ST_Distance(s.geom::geography,${location}::geography) LIMIT 1`.execute(trx)).rows[0];
        if (!nearest) throw new ImportError(400,"asset_has_no_segments");
        classification = CLASSIFICATION_ORDER[Math.max(CLASSIFICATION_ORDER.indexOf(classification),CLASSIFICATION_ORDER.indexOf(nearest.classification))] ?? "HIGHLY_RESTRICTED";
        const area = (await sql<{ inside: boolean | null }>`SELECT ST_Covers(import_area,${location}) AS inside FROM app.organisation WHERE org_id=${user.orgId}`.execute(trx)).rows[0];
        const duplicate = (await sql<{ duplicate: boolean }>`SELECT EXISTS(SELECT 1 FROM app.kml_import_item i JOIN app.kml_import k ON k.id=i.kml_import_id AND k.org_id=i.org_id
          WHERE i.org_id=${user.orgId} AND k.status='committed' AND i.simulated IS TRUE AND i.geom && ${location} AND ST_Equals(i.geom,${location}))
          OR EXISTS(SELECT 1 FROM app.asset a WHERE a.org_id=${user.orgId} AND a.type='facility' AND a.simulated IS TRUE AND a.geom && ${location} AND ST_Equals(a.geom,${location}))
          OR EXISTS(SELECT 1 FROM app.geo_reference g WHERE g.org_id=${user.orgId} AND g.simulated IS TRUE AND g.geom && ${location} AND ST_Equals(g.geom,${location})) AS duplicate`.execute(trx)).rows[0];
        const flags: string[] = [];
        if (nearest.distance > mapping.toleranceMetres) flags.push("outside_snap_tolerance");
        if (area?.inside === false) flags.push("outside_organisation_area");
        if (area?.inside == null) flags.push("organisation_area_unconfigured");
        if (duplicate?.duplicate || points.some((other) => other.longitude === point.longitude && other.latitude === point.latitude)) flags.push("duplicate");
        points.push({ ...point, distanceMetres: nearest.distance, chainageMetres: nearest.distance <= mapping.toleranceMetres ? nearest.chainage : null, flags });
      }
      const validationHash = await this.contextHash(trx,user,mapping);
      const saved = (await sql<ImportRow>`UPDATE app.kml_import SET preview=${JSON.stringify(points)}::jsonb,mapping=${JSON.stringify(mapping)}::jsonb,validation_hash=${validationHash},
        classification=${classification},status='mapped',version=version+1 WHERE id=${id}::uuid AND org_id=${user.orgId} RETURNING *`.execute(trx)).rows[0];
      if (!saved) throw new ImportError(503,"service_unavailable"); return result(saved);
    });
  }
  async command(user: CurrentUser,id: string,version: number,command: "commit" | "rollback",key: string) {
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`import-commit:${user.orgId}`},0))`.execute(trx);
      const row = await this.read(trx,user,id,true);
      const storedKey = command === "commit" ? row.commit_key : row.rollback_key;
      if (storedKey === key) return result(row);
      if (row.version !== version || row.status !== (command === "commit" ? "mapped" : "committed") || !row.mapping) throw new ImportError(409,"conflict");
      const mapping = row.mapping;
      if (command === "commit") {
        // Parent UPDATE locks also prevent new FK children from changing the context.
        const asset = (await sql`SELECT id FROM app.asset WHERE id=${mapping.assetId}::uuid AND org_id=${user.orgId} AND simulated IS TRUE AND classification=ANY(${allowed(user)}::text[]) FOR UPDATE`.execute(trx)).rows[0];
        if (!asset) throw new ImportError(404,"not_found");
        if (mapping.target === "evidence") {
          const barrier = (await sql`SELECT id FROM app.barrier WHERE id=${mapping.barrierId}::uuid AND org_id=${user.orgId} AND simulated IS TRUE AND classification=ANY(${allowed(user)}::text[]) FOR UPDATE`.execute(trx)).rows[0];
          if (!barrier) throw new ImportError(404,"not_found");
        }
        await sql`SELECT id FROM app.segment WHERE asset_id=${mapping.assetId}::uuid AND org_id=${user.orgId} FOR SHARE`.execute(trx);
        await sql`SELECT id FROM app.organisation WHERE org_id=${user.orgId} FOR SHARE`.execute(trx);
        await sql`SELECT id FROM app.barrier_path WHERE barrier_id=${mapping.barrierId}::uuid AND org_id=${user.orgId} ORDER BY id FOR SHARE`.execute(trx);
        await sql`SELECT id FROM app.threat WHERE org_id=${user.orgId} AND id IN
          (SELECT threat_id FROM app.barrier_path WHERE barrier_id=${mapping.barrierId}::uuid AND org_id=${user.orgId}) ORDER BY id FOR SHARE`.execute(trx);
        await sql`SELECT id FROM app.consequence WHERE org_id=${user.orgId} AND id IN
          (SELECT consequence_id FROM app.barrier_path WHERE barrier_id=${mapping.barrierId}::uuid AND org_id=${user.orgId}) ORDER BY id FOR SHARE`.execute(trx);
        const relatedBowties = sql`SELECT COALESCE(t.bowtie_id,c.bowtie_id) FROM app.barrier_path bp
          LEFT JOIN app.threat t ON t.id=bp.threat_id AND t.org_id=bp.org_id
          LEFT JOIN app.consequence c ON c.id=bp.consequence_id AND c.org_id=bp.org_id
          WHERE bp.barrier_id=${mapping.barrierId}::uuid AND bp.org_id=${user.orgId}`;
        await sql`SELECT id FROM app.bowtie WHERE org_id=${user.orgId} AND id IN (${relatedBowties}) ORDER BY id FOR UPDATE`.execute(trx);
        await sql`SELECT bowtie_id,asset_id FROM app.bowtie_asset WHERE org_id=${user.orgId}
          AND bowtie_id IN (${relatedBowties}) ORDER BY bowtie_id,asset_id FOR SHARE`.execute(trx);
        if (row.validation_hash !== await this.contextHash(trx,user,mapping)) throw new ImportError(409,"mapping_stale");
        if (row.preview.some((point) => point.flags.includes("duplicate"))) throw new ImportError(409,"duplicates_require_new_upload");
        for (const point of row.preview) {
          const targetId = randomUUID();
          const geoReferenceId = mapping.target === "evidence" ? randomUUID() : null;
          const location = sql`ST_SetSRID(ST_MakePoint(${point.longitude},${point.latitude}),4326)`;
          const duplicate = (await sql<{ duplicate: boolean }>`SELECT EXISTS (SELECT 1 FROM app.kml_import_item i JOIN app.kml_import k ON k.id=i.kml_import_id AND k.org_id=i.org_id
            WHERE i.org_id=${user.orgId} AND k.status='committed' AND i.simulated IS TRUE AND i.geom && ${location} AND ST_Equals(i.geom,${location}))
            OR EXISTS (SELECT 1 FROM app.asset a WHERE a.org_id=${user.orgId} AND a.type='facility' AND a.simulated IS TRUE AND a.geom && ${location} AND ST_Equals(a.geom,${location}))
            OR EXISTS (SELECT 1 FROM app.geo_reference g WHERE g.org_id=${user.orgId} AND g.simulated IS TRUE AND g.geom && ${location} AND ST_Equals(g.geom,${location})) AS duplicate`.execute(trx)).rows[0];
          if (duplicate?.duplicate) throw new ImportError(409,"duplicate");
          const attributes = { name: point.attributes[mapping.nameField] ?? "", description: point.attributes[mapping.descriptionField] ?? "", category: point.attributes[mapping.categoryField] ?? "", importId: id, label: "SIMULATION" };
          if (mapping.target === "facility") {
            await sql`INSERT INTO app.asset (id,org_id,type,parent_id,geom,attributes,simulated,classification,created_by)
              VALUES (${targetId}::uuid,${user.orgId},'facility',${mapping.assetId}::uuid,${location},${JSON.stringify(attributes)}::jsonb,true,${row.classification},${user.sub})`.execute(trx);
          } else {
            await sql`INSERT INTO app.evidence (id,org_id,barrier_id,kind,source,observed_at,simulated,classification,created_by)
              VALUES (${targetId}::uuid,${user.orgId},${mapping.barrierId}::uuid,'kml_import',${`kml:${row.file_hash}:${point.id}`},${row.created_at},true,${row.classification},${user.sub})`.execute(trx);
            await sql`INSERT INTO app.geo_reference (id,org_id,evidence_id,target_type,target_id,kind,geom,chainage_from,chainage_to,status,simulated,classification,created_by)
              VALUES (${geoReferenceId}::uuid,${user.orgId},${targetId}::uuid,'asset',${mapping.assetId}::uuid,'point',${location},${point.chainageMetres},${point.chainageMetres},'imported',true,${row.classification},${user.sub})`.execute(trx);
          }
          await sql`INSERT INTO app.kml_import_item (id,org_id,kml_import_id,geom,snapped_chainage,distance,target,target_id,asset_id,attributes,flags,simulated,classification,created_by)
            VALUES (${point.id}::uuid,${user.orgId},${id}::uuid,${location},${point.chainageMetres},${point.distanceMetres},${mapping.target},${targetId}::uuid,${mapping.assetId}::uuid,
            ${JSON.stringify({...attributes,geoReferenceId})}::jsonb,${JSON.stringify(point.flags)}::jsonb,true,${row.classification},${user.sub})`.execute(trx);
        }
      } else {
        // Lock imported parents before checking later FK dependants.
        await sql`SELECT id FROM app.evidence WHERE org_id=${user.orgId} AND id IN
          (SELECT target_id FROM app.kml_import_item WHERE kml_import_id=${id}::uuid AND org_id=${user.orgId} AND target='evidence') ORDER BY id FOR UPDATE`.execute(trx);
        await sql`SELECT id FROM app.asset WHERE org_id=${user.orgId} AND id IN
          (SELECT target_id FROM app.kml_import_item WHERE kml_import_id=${id}::uuid AND org_id=${user.orgId} AND target='facility') ORDER BY id FOR UPDATE`.execute(trx);
        const laterReferences = (await sql<{exists:boolean}>`SELECT EXISTS (
          SELECT 1 FROM app.geo_reference g JOIN app.kml_import_item i
          ON i.org_id=g.org_id AND ((i.target='evidence' AND i.target_id=g.evidence_id)
            OR (i.target='facility' AND g.target_type='asset' AND i.target_id=g.target_id))
          WHERE i.org_id=${user.orgId} AND i.kml_import_id=${id}::uuid
            AND (i.target='facility' OR i.attributes->>'geoReferenceId' IS NULL OR g.id::text<>i.attributes->>'geoReferenceId')
        ) AS exists`.execute(trx)).rows[0];
        if (laterReferences?.exists) throw new ImportError(409,"rollback_conflict");
        // Only this batch's created records are removed; audit history remains append-only.
        await sql`DELETE FROM app.geo_reference WHERE org_id=${user.orgId} AND id IN
          (SELECT (attributes->>'geoReferenceId')::uuid FROM app.kml_import_item WHERE kml_import_id=${id}::uuid AND org_id=${user.orgId} AND target='evidence')`.execute(trx);
        await sql`DELETE FROM app.evidence WHERE org_id=${user.orgId} AND id IN (SELECT target_id FROM app.kml_import_item WHERE kml_import_id=${id}::uuid AND org_id=${user.orgId} AND target='evidence')`.execute(trx);
        await sql`DELETE FROM app.asset WHERE org_id=${user.orgId} AND id IN (SELECT target_id FROM app.kml_import_item WHERE kml_import_id=${id}::uuid AND org_id=${user.orgId} AND target='facility')`.execute(trx);
      }
      await sql`INSERT INTO app.audit_event (org_id,actor,action,entity,after_hash,simulated,classification,created_by)
        VALUES (${user.orgId},${user.sub},${`import.${command}`},${id},${row.file_hash},true,${row.classification},${user.sub})`.execute(trx);
      const saved = (await sql<ImportRow>`UPDATE app.kml_import SET status=${command === "commit" ? "committed" : "rolled_back"},version=version+1,
        ${command === "commit" ? sql`commit_key=${key}` : sql`rollback_key=${key}`} WHERE id=${id}::uuid AND org_id=${user.orgId} RETURNING *`.execute(trx)).rows[0];
      if (!saved) throw new ImportError(503,"service_unavailable"); return result(saved);
    }).catch((error:unknown) => {
      if (command === "rollback" && (error as {code?:unknown} | null)?.code === "23503") throw new ImportError(409,"rollback_conflict");
      throw error;
    });
  }
}
