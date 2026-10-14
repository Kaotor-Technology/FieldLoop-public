import { parse } from "yaml";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GenAiSafetyPack } from "@fieldloop/contracts";
import { loadDomainPacks } from "../src/domain-pack-loader.js";

const root = new URL("../../../domain-packs/", import.meta.url);
const tools = new Set(["get_asset", "get_barriers", "get_bowtie_risk", "get_action_requests", "get_stakeholders", "get_scenario_state", "search_knowledge", "get_document", "spatial_query", "extract_geo_references", "create_draft", "create_action_request"]);
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
function item<T>(values: T[], index = 0): T {
  const value = values[index];
  if (value === undefined) throw new Error("test fixture item missing");
  return value;
}

async function fixture(change: (safety: GenAiSafetyPack) => void) {
  const directory = await mkdtemp(join(tmpdir(), "fl85-pack-"));
  directories.push(directory);
  await cp(root, directory, { recursive: true });
  const file = join(directory, "gen-ai-safety", "ai-safety.yaml");
  const safety = parse(await readFile(file, "utf8")) as GenAiSafetyPack;
  change(safety);
  await writeFile(file, JSON.stringify(safety));
  return directory;
}

describe("Gen AI Safety pack (FL-85)", () => {
  it("loads UC-1 once with four Technical policy Barriers and the complete PRD Bowtie C", async () => {
    const packs = await loadDomainPacks(root, tools);
    const safety = packs.find(({ content }) => content.id === "gen-ai-safety")?.aiSafety;
    expect(safety).toBeDefined();
    if (!safety) throw new Error("missing safety pack");
    expect(safety.aiSystem.agentIds).toEqual(packs.find(({ content }) => content.id === "pipeline-integrity")?.agents.map(({ id }) => id));
    expect(safety.bowtie).toMatchObject({ id: "uc-1-bowtie-c", status: "draft", hazard: "An LLM with access to Highly Restricted documents" });
    expect(safety.bowtie.threats).toHaveLength(4);
    expect(safety.bowtie.consequences.map(({ severity }) => severity.value)).toEqual([5, 4]);
    expect(safety.bowtie.barriers).toHaveLength(12);
    expect(safety.bowtie.barriers.every(({ health }) => health === "unverified")).toBe(true);
    expect(safety.bowtie.paths).toHaveLength(6);
    expect(safety.bowtie.barriers.flatMap(({ degradationFactors }) => degradationFactors).map(({ controls }) => controls[0]?.description))
      .toEqual(["Monthly red-team evaluation", "Labelling SLA", "Revision guard"]);
    expect(safety.bowtie.crossDomainLinks[0]).toMatchObject({ targetBowtieCode: "bowtie-b", targetThreatCode: "phishing-pivot", resolution: "template-only" });
    expect(safety.policies.map(({ id, barrierId }) => [id, barrierId])).toEqual([
      ["injection-detector", "injection-detector"],
      ["restricted-data-routing", "classification-routing"],
      ["output-dlp", "output-dlp"],
      ["system-of-record-tool-block", "tool-call-policy"],
    ]);
    for (const policy of safety.policies) expect(safety.bowtie.barriers.find(({ id }) => id === policy.barrierId)?.type).toBe("technical");
    expect(await loadDomainPacks(root, tools)).toEqual(packs);
  });

  it.each([
    ["unknown detector", (s: GenAiSafetyPack) => { Reflect.set(item(s.policies, 0), "detector", "missing-detector"); }, /detector/],
    ["missing Barrier", (s: GenAiSafetyPack) => { item(s.policies, 0).barrierId = "absent"; }, /Technical Barrier/],
    ["Human policy Barrier", (s: GenAiSafetyPack) => { item(s.bowtie.barriers, 0).type = "human"; item(s.bowtie.barriers, 0).pfdBand = 0.1; }, /Technical Barrier/],
    ["duplicate policy", (s: GenAiSafetyPack) => { item(s.policies, 1).id = item(s.policies, 0).id; }, /Duplicate policy/],
    ["unknown path", (s: GenAiSafetyPack) => { item(s.bowtie.paths, 0).targetId = "absent"; }, /path target/],
    ["missing path", (s: GenAiSafetyPack) => { s.bowtie.paths.pop(); }, /cover every/],
    ["missing common cause", (s: GenAiSafetyPack) => { s.bowtie.independenceGroup.barrierIds.pop(); }, /Independence Group/],
    ["line-up mismatch", (s: GenAiSafetyPack) => { s.aiSystem.agentIds.pop(); }, /line-up/],
    ["unknown tool", (s: GenAiSafetyPack) => { s.aiSystem.tools.push("approve_action"); }, /unknown tool/],
    ["public tier enabled", (s: GenAiSafetyPack) => { item(s.aiSystem.modelRoutes, 2).enabled = true; }, /model boundary/],
    ["restricted data on public tier", (s: GenAiSafetyPack) => { const p = item(s.policies, 1); if (p.kind === "classification-routing") item(p.settings.routes, 3).allowedModelTiers = ["public-saas"]; }, /model tier|private boundary/],
    ["missing class route", (s: GenAiSafetyPack) => { const p = item(s.policies, 1); if (p.kind === "classification-routing") p.settings.routes.pop(); }, /every data class/],
    ["wrong version", (s: GenAiSafetyPack) => { s.version = "2.0.0"; }, /metadata/],
  ] as const)("rejects %s with the source filename", async (_name, change, error) => {
    const directory = await fixture(change);
    await expect(loadDomainPacks(directory, tools)).rejects.toThrow(error);
    await expect(loadDomainPacks(directory, tools)).rejects.toThrow("ai-safety.yaml");
  });
});
