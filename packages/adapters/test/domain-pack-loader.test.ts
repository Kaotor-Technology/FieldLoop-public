import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDomainPacks } from "../src/domain-pack-loader.js";

const root = new URL("../../../domain-packs/", import.meta.url);
const tools = new Set(["get_asset", "get_barriers", "get_bowtie_risk", "get_action_requests", "get_stakeholders", "get_scenario_state", "search_knowledge", "get_document", "spatial_query", "extract_geo_references", "create_draft", "create_action_request"]);

async function fixture(change: (pack: Record<string, unknown>, agent: Record<string, unknown>) => void) {
  const directory = await mkdtemp(join(tmpdir(), "fl78-pack-"));
  await mkdir(join(directory, "pipeline-integrity", "agents"), { recursive: true });
  // JSON is also YAML, keeping mutations unambiguous.
  const { parse } = await import("yaml");
  const pack = parse(await readFile(new URL("pipeline-integrity/pack.yaml", root), "utf8")) as Record<string, unknown>;
  const agent = parse(await readFile(new URL("pipeline-integrity/agents/code-standard.yaml", root), "utf8")) as Record<string, unknown>;
  pack["agentFiles"] = ["agents/code-standard.yaml"];
  change(pack, agent);
  await writeFile(join(directory, "pipeline-integrity", "pack.yaml"), JSON.stringify(pack));
  await writeFile(join(directory, "pipeline-integrity", "agents", "code-standard.yaml"), JSON.stringify(agent));
  return directory;
}

describe("Domain Pack loading (FL-78 / D10 / D11)", () => {
  it("loads both demo packs deterministically with bounded agents and proposal-only rules", async () => {
    const packs = await loadDomainPacks(root, tools);
    expect(packs.map(({ content }) => content.id)).toEqual(["flood-water", "pipeline-integrity"]);
    expect(packs.flatMap(({ agents }) => agents.map(({ id }) => id)).sort()).toEqual([
      "code-standard", "flood-situation", "inspection-data-prep", "integrity-orchestrator", "regulatory", "report-generator",
    ]);
    expect(packs.flatMap(({ content }) => content.signalRules).every(({ effect }) => effect.kind === "health_proposal")).toBe(true);
    expect(await loadDomainPacks(root, tools)).toEqual(packs);
  });

  it("matches each pack's golden catalog and simulation rule outcomes", async () => {
    for (const { content, agents } of await loadDomainPacks(root, tools)) {
      const golden: unknown = JSON.parse(await readFile(new URL(`${content.id}/golden.json`, root), "utf8"));
      expect({
        label: content.label,
        agents: agents.map(({ id }) => id).sort(),
        rules: content.signalRules.map((rule) => ({
          id: rule.id,
          ...(rule.condition.kind === "signal" ? {
            source: rule.condition.source, tag: rule.condition.tag, operator: rule.condition.operator,
            threshold: rule.condition.threshold,
            ...(rule.condition.windowSeconds ? { windowSeconds: rule.condition.windowSeconds } : {}),
          } : { intervalSource: rule.condition.intervalSource }),
          health: rule.effect.proposedHealth, barriers: rule.targetBarrierSelector.barrierCodes,
        })),
      }).toEqual(golden);
    }
  });

  it("rejects invalid pack schema with the source filename", async () => {
    const directory = await fixture((pack) => { pack["version"] = "invalid"; });
    await expect(loadDomainPacks(directory, tools)).rejects.toThrow(/pack.yaml.*version/);
  });

  it("loads valid spatial rules without losing their coordinates", async () => {
    const geometry = { type: "Polygon", coordinates: [[[100, 13], [101, 13], [101, 14], [100, 14], [100, 13]]] };
    const directory = await fixture((pack) => {
      const rules = pack["signalRules"] as { spatialGeometry?: unknown }[];
      if (rules[0]) rules[0].spatialGeometry = geometry;
    });
    const packs = await loadDomainPacks(directory, tools);
    expect(packs[0]?.content.signalRules[0].spatialGeometry).toEqual(geometry);
  });

  it("rejects an agent that exceeds the demo step ceiling", async () => {
    const directory = await fixture((_pack, agent) => { agent["maxSteps"] = 9; });
    await expect(loadDomainPacks(directory, tools)).rejects.toThrow(/code-standard.yaml.*maxSteps/);
  });

  it("rejects unknown tools with the agent filename", async () => {
    const directory = await fixture((_pack, agent) => { agent["allowedTools"] = ["cmms.create_work_order"]; });
    await expect(loadDomainPacks(directory, tools)).rejects.toThrow(/code-standard.yaml.*cmms.create_work_order/);
  });

  it("rejects duplicate rules and cross-pack selectors", async () => {
    const directory = await fixture((pack) => {
      const rules = pack["signalRules"] as { targetBarrierSelector: { pack: string } }[];
      rules.push(structuredClone(rules[0]) as (typeof rules)[number]);
    });
    await expect(loadDomainPacks(directory, tools)).rejects.toThrow(/pack.yaml.*Duplicate rule/);
    const crossPack = await fixture((pack) => {
      const rules = pack["signalRules"] as { targetBarrierSelector: { pack: string } }[];
      if (rules[0]) rules[0].targetBarrierSelector.pack = "flood-water";
    });
    await expect(loadDomainPacks(crossPack, tools)).rejects.toThrow(/pack.yaml.*selector/);
  });

  it("rejects undeclared and missing district placeholders in either language", async () => {
    const directory = await fixture((pack) => {
      pack["warningTemplates"] = [{ id: "district-warning", actionLevel: "L2", approvalRequired: true,
        placeholders: ["district"], en: "SIMULATION {{district}} {{secret}}", th: "SIMULATION {{district}}" }];
    });
    await expect(loadDomainPacks(directory, tools)).rejects.toThrow(/pack.yaml.*placeholder/);
    const missing = await fixture((pack) => {
      pack["warningTemplates"] = [{ id: "district-warning", actionLevel: "L2", approvalRequired: true,
        placeholders: ["district"], en: "SIMULATION", th: "SIMULATION {{district}}" }];
    });
    await expect(loadDomainPacks(missing, tools)).rejects.toThrow(/pack.yaml/);
  });

  it("rejects unresolved handoffs, cycles and invalid spatial rings", async () => {
    const missing = await fixture((_pack, agent) => { agent["delegates"] = ["missing-agent"]; agent["kind"] = "coordinator"; });
    await expect(loadDomainPacks(missing, tools)).rejects.toThrow(/code-standard.yaml.*delegate/);
    const cycle = await fixture((_pack, agent) => { agent["delegates"] = ["code-standard"]; agent["kind"] = "coordinator"; });
    await expect(loadDomainPacks(cycle, tools)).rejects.toThrow(/code-standard.yaml.*cycle/);
    const ring = await fixture((pack) => {
      const rules = pack["signalRules"] as { spatialGeometry?: unknown }[];
      if (rules[0]) rules[0].spatialGeometry = { type: "Polygon", coordinates: [[[100, 13], [101, 13], [101, 14], [100, 14]]] };
    });
    await expect(loadDomainPacks(ring, tools)).rejects.toThrow(/pack.yaml.*closed/);
  });
});
