import { sql, type Kysely } from "kysely";
import type { LoadedDomainPack } from "@fieldloop/adapters";
import { domainPackRecordId } from "./domain-pack-record-id.js";

type RecordValues = Record<string, unknown>;
const json = (value: unknown) => sql`${JSON.stringify(value)}::jsonb`;

/** Called inside the catalog transaction; only authored fields are updated on reload. */
export async function registerGenAiSafetyRecords<Database>(database: Kysely<Database>, orgId: string, pack: LoadedDomainPack): Promise<void> {
  const safety = pack.aiSafety;
  if (!safety) return;
  const { aiSystem, bowtie, policies } = safety;
  const id = (kind: string, code: string) => domainPackRecordId(orgId, pack.content.id, kind, code);
  const metadata = { org_id: orgId, simulated: safety.simulated, classification: safety.classification, created_by: "domain-pack-loader" };
  async function upsert(table: string, values: RecordValues, preserve: string[] = []) {
    const keys = Object.keys(values);
    const updates = keys.filter((key) => key !== "id" && !preserve.includes(key));
    await sql`INSERT INTO ${sql.table(`app.${table}`)} (${sql.join(keys.map((key) => sql.ref(key)))})
      VALUES (${sql.join(keys.map((key) => values[key]))})
      ON CONFLICT (id) DO UPDATE SET ${sql.join(updates.map((key) => sql`${sql.ref(key)} = ${sql.ref(`excluded.${key}`)}`))}`.execute(database);
  }
  const bowtieId = id("bowtie", bowtie.id);
  await upsert("bowtie", { id: bowtieId, ...metadata, hazard: bowtie.hazard, top_event: bowtie.topEvent,
    domain: bowtie.domain, status: bowtie.status, version: safety.version }, ["status"]);
  const groupId = id("independence_group", bowtie.independenceGroup.id);
  await upsert("independence_group", { id: groupId, ...metadata, bowtie_id: bowtieId, cause: bowtie.independenceGroup.cause });
  for (const threat of bowtie.threats) {
    await upsert("threat", { id: id("threat", threat.id), ...metadata, bowtie_id: bowtieId,
      threat_category_id: id("threat_category", threat.categoryCode), name: threat.name });
  }
  for (const consequence of bowtie.consequences) {
    await upsert("consequence", { id: id("consequence", consequence.id), ...metadata, bowtie_id: bowtieId,
      name: consequence.name, severity: json({ [consequence.severity.dimension]: consequence.severity.value }) });
  }
  for (const barrier of bowtie.barriers) {
    await upsert("barrier", { id: id("barrier", barrier.id), ...metadata, name: barrier.name,
      type: barrier.type, side: barrier.side, pfd_band: barrier.pfdBand, health: barrier.health,
      independence_group_id: bowtie.independenceGroup.barrierIds.includes(barrier.id) ? groupId : null,
      performance_standard: barrier.performanceStandard,
      triad: json({ ...barrier.triad, pack: pack.content.id, bowtieCode: bowtie.id, barrierCode: barrier.id,
        implementation: barrier.implementation, parameterBasis: safety.parameterBasis }) }, ["health"]);
    for (const factor of barrier.degradationFactors) {
      const factorId = id("degradation_factor", `${barrier.id}:${factor.id}`);
      await upsert("degradation_factor", { id: factorId, ...metadata, barrier_id: id("barrier", barrier.id), description: factor.description });
      for (const control of factor.controls) {
        await upsert("degradation_control", { id: id("degradation_control", `${barrier.id}:${factor.id}:${control.id}`),
          ...metadata, degradation_factor_id: factorId, description: control.description });
      }
    }
  }
  for (const path of bowtie.paths) {
    for (const [position, barrierId] of path.barrierIds.entries()) {
      await upsert("barrier_path", { id: id("barrier_path", `${path.id}:${barrierId}`), ...metadata,
        barrier_id: id("barrier", barrierId), position: position + 1,
        threat_id: path.side === "preventive" ? id("threat", path.targetId) : null,
        consequence_id: path.side === "mitigative" ? id("consequence", path.targetId) : null });
    }
  }
  const aiSystemId = id("ai_system", aiSystem.id);
  await upsert("ai_system", { id: aiSystemId, ...metadata, name: aiSystem.name, model_tier: aiSystem.modelTier,
    data_classes: json(aiSystem.dataClasses), tools: json(aiSystem.tools), risk_class: aiSystem.riskClass });
  for (const policy of policies) {
    await upsert("guardrail_policy", { id: id("guardrail_policy", policy.id), ...metadata,
      ai_system_id: aiSystemId, barrier_id: id("barrier", policy.barrierId), tier: policy.tier,
      mode: policy.mode, fail_mode: policy.failMode,
      config: json({ ...policy, pack: pack.content.id, packVersion: safety.version,
        aiSystemCode: aiSystem.id, bowtieCode: bowtie.id, bowtieId, modelRoutes: aiSystem.modelRoutes }) });
  }
}
