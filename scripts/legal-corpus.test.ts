import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type SeedQuery = { sql: string; parameters: unknown[] };
type LegalRecord = {
  documentKey: string;
  status: string;
  reviewRequired: boolean;
  simulated: boolean;
  classification: string;
  contentPath: string | null;
  contentState: string;
};
type LegalManifest = { recordCount: number; records: LegalRecord[] };

const repositoryRoot = resolve(".");
const manifestFile = resolve("data/corpus/legal/manifest.json");
const seeder = resolve("data/corpus/legal/seed.mjs");

function readManifest(): LegalManifest {
  return JSON.parse(readFileSync(manifestFile, "utf8")) as LegalManifest;
}

function previewSeed(orgId: string): SeedQuery[] {
  return JSON.parse(execFileSync(
    process.execPath,
    [seeder, "--print-sql", "--org-id", orgId],
    { cwd: repositoryRoot, encoding: "utf8" },
  )) as SeedQuery[];
}

describe("legal corpus manifest and Controlled Document loader", () => {
  it("contains the 16 Thai research records and both requested CFR parts", () => {
    const manifest = readManifest();

    expect(manifest.recordCount).toBe(18);
    expect(manifest.records.filter(({ documentKey }) => documentKey.startsWith("TH-"))).toHaveLength(16);
    expect(manifest.records.map(({ documentKey }) => documentKey)).toContain("US-49-CFR-192");
    expect(manifest.records.map(({ documentKey }) => documentKey)).toContain("US-49-CFR-195");
  });

  it("keeps every flagged law unverified and metadata-only", () => {
    const flagged = readManifest().records.filter(({ reviewRequired }) => reviewRequired);

    expect(flagged).toHaveLength(8);
    for (const record of flagged) {
      expect(record.status).toBe("status unverified");
      expect(record.contentPath).toBeNull();
      expect(record.contentState).toBe("metadata_only");
    }
  });

  it("includes full source XML snapshots for 49 CFR Parts 192 and 195", () => {
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as {
      records: { documentKey: string; contentPath: string | null; contentState: string }[];
    };
    const part192 = manifest.records.find(({ documentKey }) => documentKey === "US-49-CFR-192");
    const part195 = manifest.records.find(({ documentKey }) => documentKey === "US-49-CFR-195");
    if (!part192?.contentPath || !part195?.contentPath) {
      throw new Error("Both CFR records must point to a source snapshot.");
    }

    for (const record of [part192, part195]) {
      expect(record.contentState).toBe("full_text_snapshot");
      expect(existsSync(resolve("data/corpus/legal", record.contentPath))).toBe(true);
    }
    expect(readFileSync(resolve("data/corpus/legal", part192.contentPath), "utf8")).toContain("PART 192—");
    expect(readFileSync(resolve("data/corpus/legal", part192.contentPath), "utf8")).toContain("§ 192.1");
    expect(readFileSync(resolve("data/corpus/legal", part195.contentPath), "utf8")).toContain("PART 195—");
    expect(readFileSync(resolve("data/corpus/legal", part195.contentPath), "utf8")).toContain("§ 195.1");
  });

  it("creates parameterized public Controlled Document records without a database connection", () => {
    const manifest = readManifest();
    const queries = previewSeed("demo'pipeline");

    expect(queries).toHaveLength(manifest.recordCount);
    for (const query of queries) {
      expect(query.sql).toContain('"app"."controlled_document"');
      expect(query.sql).toContain("on conflict");
      expect(query.parameters).toContain("demo'pipeline");
      expect(query.parameters).toContain("public");
      expect(query.parameters).toContain(false);
      expect(query.parameters).toContain(null);
    }

    const statuses = queries.map(({ parameters }) => parameters.find((value) => value === "status unverified"));
    expect(statuses.filter(Boolean)).toHaveLength(8);
  });

  it("rejects a manifest that would publish an unverified item as current text", () => {
    const manifest = readManifest();
    const flagged = manifest.records.find(({ reviewRequired }) => reviewRequired);
    if (!flagged) {
      throw new Error("Expected at least one flagged legal record.");
    }
    flagged.status = "in force";
    flagged.contentPath = "documents/incorrectly-current.xml";
    flagged.contentState = "full_text_snapshot";

    const validation = execFileSync(process.execPath, [
      "--input-type=module",
      "--eval",
      `import { validateManifest } from ${JSON.stringify(`file://${seeder}`)};\n` +
        `const manifest = JSON.parse(${JSON.stringify(JSON.stringify(manifest))});\n` +
        `try { validateManifest(manifest); process.exit(2); } catch (error) { console.log(error.message); }`,
    ], { cwd: repositoryRoot, encoding: "utf8" });
    expect(validation).toContain("must require review and remain metadata-only");
  });
});
