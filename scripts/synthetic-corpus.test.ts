import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type CorpusManifest = {
  documentCount: number;
  documents: {
    documentId: string;
    documentType: string;
    language: "en" | "th";
    revision: "A" | "B";
    status: string;
    reviewStatus: string;
    simulated: boolean;
    label: string;
    supersedes: string | null;
    supersededBy: string | null;
    contentPath: string;
  }[];
};

const repositoryRoot = resolve(".");
const generator = resolve("data/synthetic/corpus/generate.mjs");
const generatedDirectories: string[] = [];

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "fieldloop-corpus-"));
  generatedDirectories.push(directory);
  return directory;
}

function generateInto(directory: string) {
  execFileSync(process.execPath, [generator, "--output-dir", directory], {
    cwd: repositoryRoot,
  });
}

function readManifest(directory: string): CorpusManifest {
  return JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as CorpusManifest;
}

afterEach(() => {
  for (const directory of generatedDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("synthetic document corpus generator", () => {
  it("generates 240 bilingual documents across all five required document types", () => {
    const directory = temporaryDirectory();
    generateInto(directory);
    const manifest = readManifest(directory);

    expect(manifest.documentCount).toBe(240);
    expect(manifest.documents).toHaveLength(240);
    expect(new Set(manifest.documents.map(({ documentType }) => documentType))).toEqual(
      new Set(["procedure", "ili-report", "patrol-log", "root-cause-analysis", "memo"]),
    );
    expect(manifest.documents.filter(({ language }) => language === "en")).toHaveLength(120);
    expect(manifest.documents.filter(({ language }) => language === "th")).toHaveLength(120);
    expect(manifest.documents.filter(({ revision }) => revision === "A")).toHaveLength(120);
    expect(manifest.documents.filter(({ revision }) => revision === "B")).toHaveLength(120);
  });

  it("keeps every generated record labelled, simulated, and pending human review", () => {
    const directory = temporaryDirectory();
    generateInto(directory);
    const manifest = readManifest(directory);

    for (const document of manifest.documents) {
      expect(document.status).toBe("draft");
      expect(document.reviewStatus).toBe("pending");
      expect(document.simulated).toBe(true);
      expect(document.label).toBe("SYNTHETIC");
      const content = readFileSync(join(directory, document.contentPath), "utf8");
      expect(content).toContain("SYNTHETIC");
      expect(content).toContain("Human review is pending");
      if (document.revision === "A") {
        expect(document.supersededBy).not.toBeNull();
        expect(document.supersedes).toBeNull();
      } else {
        expect(document.supersedes).not.toBeNull();
        expect(document.supersededBy).toBeNull();
      }
    }
  });

  it("writes a deterministic review checklist without decisions prefilled", () => {
    const firstDirectory = temporaryDirectory();
    const secondDirectory = temporaryDirectory();
    generateInto(firstDirectory);
    generateInto(secondDirectory);

    for (const filename of ["manifest.json", "review-checklist.csv"]) {
      expect(readFileSync(join(firstDirectory, filename), "utf8")).toBe(
        readFileSync(join(secondDirectory, filename), "utf8"),
      );
    }
    const checklist = readFileSync(join(firstDirectory, "review-checklist.csv"), "utf8");
    const rows = checklist.trimEnd().split("\n");
    expect(rows).toHaveLength(241);
    for (const row of rows.slice(1)) {
      expect(row.endsWith(',"","","",""')).toBe(true);
    }
  });

  it("rejects unsupported command-line arguments", () => {
    expect(() => execFileSync(process.execPath, [generator, "--unknown"], {
      cwd: repositoryRoot,
      stdio: "pipe",
    })).toThrow(/Unknown argument: --unknown/);
  });
});
