import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { LoadedDomainPack } from "@fieldloop/adapters";
import { domainPackRecordId } from "./domain-pack-record-id.js";

type RecordValues = Record<string, unknown>;
const json = (value: unknown) => sql`${JSON.stringify(value)}::jsonb`;

function canonicalDefinition(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalDefinition);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalDefinition(child)]));
  }
  return value;
}

/** Called inside the catalog transaction; Draft definitions may reload; reviewed definitions must remain unchanged. */
export async function registerGenAiSafetyRecords<Database>(database: Kysely<Database>, orgId: string, pack: LoadedDomainPack): Promise<void> {
  const safety = pack.aiSafety;
  if (!safety) return;
  const { aiSystem, bowtie, policies } = safety;
  const id = (kind: string, code: string) => domainPackRecordId(orgId, pack.content.id, kind, code);
  const bowtieId = id("bowtie", bowtie.id);
  const aiSystemId = id("ai_system", aiSystem.id);
  const seedDefinitionHash = createHash("sha256")
    .update(JSON.stringify(canonicalDefinition({ content: pack.content, aiSafety: safety }))).digest("hex");
  // Reset/run replacement locks this row too. A startup reload must not write a
  // simulation baseline, even when INSERT would ultimately hit ON CONFLICT.
  const workspace = (await sql<{ active_run_id: string | null }>`
    SELECT active_run_id FROM app.simulation_workspace WHERE org_id = ${orgId} FOR SHARE`.execute(database)).rows[0];
  const hasRun = workspace?.active_run_id != null;
  const metadata = { org_id: orgId, simulated: safety.simulated, classification: safety.classification, created_by: "domain-pack-loader" };
  async function upsert(table: string, values: RecordValues, preserve: string[] = []) {
    const keys = Object.keys(values);
    const updates = keys.filter((key) => key !== "id" && !preserve.includes(key));
    await sql`INSERT INTO ${sql.table(`app.${table}`)} (${sql.join(keys.map((key) => sql.ref(key)))})
      VALUES (${sql.join(keys.map((key) => values[key]))})
      ON CONFLICT (id) DO UPDATE SET ${sql.join(updates.map((key) => sql`${sql.ref(key)} = ${sql.ref(`excluded.${key}`)}`))}`.execute(database);
  }
  // Establish and lock the parent before checking review state. A concurrent
  // human review cannot commit between this check and the graph registration.
  if (!hasRun) await sql`INSERT INTO app.bowtie (id, org_id, hazard, top_event, domain, status, version, simulated, classification, created_by)
    VALUES (${bowtieId}::uuid, ${orgId}, ${bowtie.hazard}, ${bowtie.topEvent}, ${bowtie.domain}, ${bowtie.status},
      ${safety.version}, ${safety.simulated}, ${safety.classification}, 'domain-pack-loader')
    ON CONFLICT (id) DO NOTHING`.execute(database);
  const existing = (await sql<{ status: string | null }>`
    SELECT status FROM app.bowtie WHERE id = ${bowtieId}::uuid AND org_id = ${orgId} FOR UPDATE`.execute(database)).rows[0];
  if (!existing) throw new Error("Gen AI Safety Bowtie registration lost its Organisation-scoped parent");
  if (existing.status !== "draft" || hasRun) {
    const proofs = (await sql<{ id: string; seed_definition_hash: string | null }>`SELECT id,
      config->>'seedDefinitionHash' AS seed_definition_hash FROM app.guardrail_policy
      WHERE org_id = ${orgId} AND ai_system_id = ${aiSystemId}::uuid AND config->>'bowtieId' = ${bowtieId}`.execute(database)).rows;
    const expected = new Set(policies.map((policy) => id("guardrail_policy", policy.id)));
    if (proofs.length !== expected.size
        || proofs.some((proof) => !expected.has(proof.id) || proof.seed_definition_hash !== seedDefinitionHash)) {
      throw new Error(`Gen AI Safety seed cannot change reviewed Bowtie ${bowtie.id} or a simulation baseline; use the human review workflow`);
    }
    return; // Identical seed: reviewed definitions and simulation state stay authoritative.
  }
  for (const category of pack.content.threatCategories) {
    await upsert("threat_category", { id: id("threat_category", category.code), ...metadata,
      pack: pack.content.id, code: category.code });
  }
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
  await upsert("ai_system", { id: aiSystemId, ...metadata, name: aiSystem.name, model_tier: aiSystem.modelTier,
    data_classes: json(aiSystem.dataClasses), tools: json(aiSystem.tools), risk_class: aiSystem.riskClass });
  for (const policy of policies) {
    await upsert("guardrail_policy", { id: id("guardrail_policy", policy.id), ...metadata,
      ai_system_id: aiSystemId, barrier_id: id("barrier", policy.barrierId), tier: policy.tier,
      mode: policy.mode, fail_mode: policy.failMode,
      config: json({ ...policy, pack: pack.content.id, packVersion: safety.version,
        aiSystemCode: aiSystem.id, bowtieCode: bowtie.id, bowtieId, seedDefinitionHash, modelRoutes: aiSystem.modelRoutes }) });
  }
}
