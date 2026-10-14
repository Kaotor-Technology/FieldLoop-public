import { parse } from "yaml";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { isRiskSeverity } from "../src/risk.js";
import { parseGenAiSafetyPack } from "../src/domain-pack.js";

function item<T>(values: T[], index = 0): T {
  const value = values[index];
  if (value === undefined) throw new Error("test fixture item missing");
  return value;
}

async function seed() {
  return parse(await readFile(new URL("../../../domain-packs/gen-ai-safety/ai-safety.yaml", import.meta.url), "utf8")) as Record<string, unknown>;
}

describe("Gen AI Safety contracts (FL-85 / FL-36)", () => {
  it("accepts the authored four enforce/fail-closed policies and UC-1 system", async () => {
    const pack = parseGenAiSafetyPack(await seed(), "ai-safety.yaml");
    expect(pack.aiSystem).toMatchObject({ id: "demo-uc-1", modelTier: "private", riskClass: "high" });
    expect(pack.aiSystem.dataClasses).toEqual(["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED"]);
    expect(pack.policies.map(({ kind }) => kind)).toEqual(["injection", "classification-routing", "output-dlp", "tool-call"]);
    expect(pack.policies.every(({ mode, failMode }) => mode === "enforce" && failMode === "fail-closed")).toBe(true);
  });

  it("keeps every authored Consequence compatible with shared RiskSeverity", async () => {
    const pack = parseGenAiSafetyPack(await seed(), "ai-safety.yaml");
    for (const { severity } of pack.bowtie.consequences) {
      expect(isRiskSeverity({ [severity.dimension]: severity.value })).toBe(true);
    }
  });

  it("rejects changing the demo Bowtie identity instead of creating a replacement", async () => {
    const pack = parseGenAiSafetyPack(await seed(), "ai-safety.yaml");
    Reflect.set(pack.bowtie, "id", "replacement-bowtie-c");
    expect(() => parseGenAiSafetyPack(pack, "ai-safety.yaml")).toThrow(/id/);
  });

  it("rejects unsupported severity dimensions before registration", async () => {
    const pack = parseGenAiSafetyPack(await seed(), "ai-safety.yaml");
    Reflect.set(item(pack.bowtie.consequences).severity, "dimension", "security");
    expect(() => parseGenAiSafetyPack(pack, "ai-safety.yaml")).toThrow(/dimension/);
  });

  it.each(["human", "organisational"])("rejects a %s Barrier better than the AS-4 ceiling", async (type) => {
    const pack = parseGenAiSafetyPack(await seed(), "ai-safety.yaml");
    const barrier = pack.bowtie.barriers.find((value) => value.type === type);
    if (!barrier) throw new Error("expected demo Barrier type");
    barrier.pfdBand = 0.01;
    expect(() => parseGenAiSafetyPack(pack, "ai-safety.yaml")).toThrow(/pfdBand/);
  });

  it.each(["detector", "mode", "failMode", "tier"])("rejects unsafe or unknown policy %s with a source filename", async (field) => {
    const value = await seed();
    const policies = value["policies"] as Record<string, unknown>[];
    item(policies, 0)[field] = "unknown-or-unsafe";
    expect(() => parseGenAiSafetyPack(value, "ai-safety.yaml")).toThrow(/ai-safety.yaml/);
  });

  it("rejects missing policies and invented operational Health", async () => {
    const value = await seed();
    (value["policies"] as unknown[]).pop();
    expect(() => parseGenAiSafetyPack(value, "ai-safety.yaml")).toThrow(/policies/);
    const health = await seed();
    const bowtie = health["bowtie"] as { barriers: { health: string }[] };
    item(bowtie.barriers, 0).health = "healthy";
    expect(() => parseGenAiSafetyPack(health, "ai-safety.yaml")).toThrow(/health/);
  });
});
