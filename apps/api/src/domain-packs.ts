import { fileURLToPath } from "node:url";
import { sql, type Kysely } from "kysely";
import { DEMO_AGENT_TOOL_NAMES, DEMO_REGISTERED_TOOL_NAMES, loadDomainPacks, type LoadedDomainPack } from "@fieldloop/adapters";

import { domainPackRecordId } from "./domain-pack-record-id.js";
import { registerGenAiSafetyRecords } from "./gen-ai-safety-seed.js";

export { DEMO_AGENT_TOOL_NAMES } from "@fieldloop/adapters";
export const DEMO_PACK_IDS = ["pipeline-integrity", "flood-water", "gen-ai-safety"] as const;

export function loadDemoDomainPacks(root: URL | string = process.env["FIELDLOOP_DOMAIN_PACKS_DIR"]
    ?? fileURLToPath(new URL("../../../domain-packs/", import.meta.url))) {
  return loadDomainPacks(root, DEMO_AGENT_TOOL_NAMES, DEMO_PACK_IDS, DEMO_REGISTERED_TOOL_NAMES);
}

export { domainPackRecordId } from "./domain-pack-record-id.js";

/** One atomic, organisation-scoped registration; stable IDs make restarts idempotent. */
export async function registerDomainPackRecords<Database>(database: Kysely<Database>, orgId: string, packs: LoadedDomainPack[]): Promise<void> {
  if (!orgId.trim()) throw new Error("Domain Pack registration requires an Organisation ID");
  await database.transaction().execute(async (transaction) => {
    for (const pack of packs) {
      const { content } = pack;
      if (pack.aiSafety) {
        await registerGenAiSafetyRecords(transaction, orgId, pack);
        continue;
      }
      for (const category of content.threatCategories) {
        const id = domainPackRecordId(orgId, content.id, "threat_category", category.code);
        await sql`INSERT INTO app.threat_category (id, org_id, pack, code, simulated, classification, created_by)
          VALUES (${id}::uuid, ${orgId}, ${content.id}, ${category.code}, ${content.simulated}, ${content.classification}, 'domain-pack-loader')
          ON CONFLICT (id) DO UPDATE SET classification = EXCLUDED.classification, simulated = EXCLUDED.simulated`.execute(transaction);
      }
      for (const rule of content.signalRules) {
        const id = domainPackRecordId(orgId, content.id, "signal_rule", rule.id);
        // Keep the rule identity, version and proposed effect in the existing generic JSONB contract.
        const condition = { ...rule.condition, ruleId: rule.id, packVersion: content.version, effect: rule.effect };
        const geometry = rule.spatialGeometry
          ? sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(rule.spatialGeometry)}::text), 4326)`
          : sql`NULL`;
        await sql`INSERT INTO app.signal_rule (id, org_id, pack, condition, target_barrier_selector, spatial_geom, simulated, classification, created_by)
          VALUES (${id}::uuid, ${orgId}, ${content.id}, ${JSON.stringify(condition)}::jsonb,
            ${JSON.stringify(rule.targetBarrierSelector)}::jsonb, ${geometry}, ${content.simulated}, ${content.classification}, 'domain-pack-loader')
          ON CONFLICT (id) DO UPDATE SET condition = EXCLUDED.condition,
            target_barrier_selector = EXCLUDED.target_barrier_selector, spatial_geom = EXCLUDED.spatial_geom,
            classification = EXCLUDED.classification, simulated = EXCLUDED.simulated`.execute(transaction);
      }
    }
  });
}
