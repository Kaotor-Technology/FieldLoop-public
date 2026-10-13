import { readFile, readdir, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { domainPackRecordId, loadDemoDomainPacks } from "../src/domain-packs.js";

describe("web-api Domain Pack startup", () => {
  it("registers the validated catalog with the application before serving", async () => {
    const packs = await loadDemoDomainPacks();
    const app = buildApp({ domainPacks: packs });
    expect(app.domainPacks.flatMap(({ agents }) => agents).map(({ id }) => id)).toContain("flood-situation");
    const pipeline = app.domainPacks.find(({ content }) => content.id === "pipeline-integrity");
    expect(pipeline?.content.signalRules.map(({ id }) => id).sort()).toEqual([
      "cp-rectifier-output-lost",
      "encroachment-detected",
      "evidence-ageing",
    ]);
    expect(pipeline?.content.signalRules.every(({ effect }) => effect.kind === "health_proposal")).toBe(true);
    expect(pipeline?.agents.map(({ id }) => id)).toEqual(expect.arrayContaining([
      "integrity-orchestrator",
      "code-standard",
      "regulatory",
      "inspection-data-prep",
      "report-generator",
    ]));
    expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
    await app.close();
  });

  it("fails closed when a required pack is absent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fl78-missing-"));
    await expect(loadDemoDomainPacks(directory)).rejects.toThrow(/no Domain Packs|required pack missing/);
  });

  it("fails before startup when a required YAML file is invalid", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fl78-invalid-"));
    await mkdir(join(directory, "flood-water"));
    await writeFile(join(directory, "flood-water", "pack.yaml"), "id: [broken");
    await expect(loadDemoDomainPacks(directory)).rejects.toThrow(/pack.yaml.*invalid YAML/);
  });

  it("keeps deterministic IDs separate across organisations, packs and entity kinds", () => {
    expect(domainPackRecordId("org-a", "pipeline-integrity", "signal_rule", "cp")).toEqual(domainPackRecordId("org-a", "pipeline-integrity", "signal_rule", "cp"));
    expect(new Set([
      domainPackRecordId("org-a", "pipeline-integrity", "signal_rule", "cp"),
      domainPackRecordId("org-b", "pipeline-integrity", "signal_rule", "cp"),
      domainPackRecordId("org-a", "flood-water", "signal_rule", "cp"),
      domainPackRecordId("org-a", "pipeline-integrity", "threat_category", "cp"),
    ]).size).toBe(4);
  });

  it("targets existing demo Bowties and Barriers without adding pipeline fields to core tables", async () => {
    const packs = await loadDemoDomainPacks();
    for (const { content } of packs) {
      const seedFile = content.id === "pipeline-integrity" ? "dl-01/bowtie-a.json" : "bangkok/bowtie-d.json";
      const seed = JSON.parse(await readFile(new URL(`../../../data/synthetic/${seedFile}`, import.meta.url), "utf8")) as { id: string; barriers: { id: string }[] };
      for (const rule of content.signalRules) {
        expect(rule.targetBarrierSelector.bowtieCode).toBe(seed.id);
        for (const code of rule.targetBarrierSelector.barrierCodes) expect(seed.barriers.map(({ id }) => id)).toContain(code);
      }
    }
  });

  it("keeps Pipeline attributes out of core migration columns", async () => {
    const migrations = new URL("../../../db/migrations/", import.meta.url);
    const names = await readdir(migrations);
    const sources = await Promise.all(names.filter((name) => name.endsWith(".sql"))
      .map((name) => readFile(new URL(name, migrations), "utf8")));
    const columns = sources.flatMap((source) => [
      ...[...source.matchAll(/^ {4}([a-z][a-z0-9_]*)\s+\S+/gm)].map(([, name]) => name),
      ...[...source.matchAll(/\bADD\s+COLUMN(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-z][a-z0-9_]*)\b/gi)]
        .map(([, name]) => name),
    ]);
    const pipelinePackFields = new Set(["right_of_way", "location_class", "hca"]);

    expect(columns.some((column) => pipelinePackFields.has(column ?? ""))).toBe(false);
  });
});
