import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type CorpusManifest = {
  documentCount: number;
  review: { pending: number; passed: number; failedAndRemoved: number };
  documents: {
    documentId: string;
    documentType: string;
    language: "en" | "th";
    revision: "A" | "B";
    status: string;
    reviewStatus: string;
    folder: string;
    simulated: boolean;
    label: string;
    supersedes: string | null;
    supersededBy: string | null;
    contentPath: string;
  }[];
};

const DOCUMENT_TYPES = ["procedure", "ili-report", "patrol-log", "root-cause-analysis", "memo"];
// Top-level folders of the Pipeline Domain Pack (PRD KL-2).
const PACK_FOLDERS = ["Company Standards", "Integrity", "Maintenance", "Lessons Learned"];

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

function documentBody(directory: string, contentPath: string) {
  const content = readFileSync(join(directory, contentPath), "utf8");
  // Drop the front matter, the title and the revision-specific lines.
  return content
    .slice(content.indexOf("\n---\n") + 5)
    .split("\n")
    .filter((line) => !line.startsWith("# ") && !line.startsWith("- Revision: "))
    .join("\n");
}

function recordDecisions(directory: string, decisions: Record<string, string[]>) {
  const checklistFile = join(directory, "review-checklist.csv");
  const source = readFileSync(checklistFile, "utf8");
  const controlColumnCount = source.split("\n")[0]?.split(",").indexOf('"reviewer"') ?? 0;
  const rows = source.trimEnd().split("\n").map((row) => {
    const documentId = row.split(",")[0]?.replaceAll('"', "") ?? "";
    const decision = decisions[documentId];
    if (!decision) {
      return row;
    }
    const cells = row.split('","').slice(0, controlColumnCount).join('","');
    return `${cells}","${decision.join('","')}"`;
  });
  writeFileSync(checklistFile, `${rows.join("\n")}\n`, "utf8");
}

afterEach(() => {
  for (const directory of generatedDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("synthetic document corpus generator", () => {
  it("rejects a changed template before replacing reviewed content or decisions", () => {
    const directory = temporaryDirectory();
    generateInto(directory);
    recordDecisions(directory, {
      "SYN-UC1-PROC-EN-001-A": ["Fixture reviewer", "pass", "2026-10-12", ""],
    });
    const checklist = readFileSync(join(directory, "review-checklist.csv"), "utf8");
    const documentPath = join(directory, "documents/syn-uc1-proc-en-001-a.md");
    const document = readFileSync(documentPath, "utf8");
    const changedGenerator = join(realpathSync(temporaryDirectory()), "generate.mjs");
    writeFileSync(changedGenerator, readFileSync(generator, "utf8").replace(
      "surface rust at a coating defect on an exposed girth weld",
      "a changed fictional finding that has not been reviewed",
    ));
    expect(() => execFileSync(process.execPath, [changedGenerator, "--output-dir", directory], {
      cwd: repositoryRoot, stdio: "pipe",
    })).toThrow(/reviewed content/);
    expect(readFileSync(documentPath, "utf8")).toBe(document);
    expect(readFileSync(join(directory, "review-checklist.csv"), "utf8")).toBe(checklist);
  });

  it("rejects a review of an edited candidate rather than replacing its text", () => {
    const directory = temporaryDirectory();
    generateInto(directory);
    const documentPath = join(directory, "documents/syn-uc1-proc-en-001-a.md");
    writeFileSync(documentPath, readFileSync(documentPath, "utf8").replace("surface rust", "edited fictional finding"));
    recordDecisions(directory, { "SYN-UC1-PROC-EN-001-A": ["Fixture reviewer", "pass", "2026-10-12", ""] });
    expect(() => generateInto(directory)).toThrow(/reviewed content/);
    expect(readFileSync(documentPath, "utf8")).toContain("edited fictional finding");
  });

  it("generates 240 documents with every document type in both languages", () => {
    const directory = temporaryDirectory();
    generateInto(directory);
    const manifest = readManifest(directory);

    expect(manifest.documentCount).toBe(240);
    expect(manifest.documents).toHaveLength(240);
    for (const documentType of DOCUMENT_TYPES) {
      for (const language of ["en", "th"]) {
        for (const revision of ["A", "B"]) {
          expect(manifest.documents.filter((document) =>
            document.documentType === documentType
            && document.language === language
            && document.revision === revision)).toHaveLength(12);
        }
      }
    }
    for (const document of manifest.documents) {
      expect(PACK_FOLDERS).toContain(document.folder.split("/")[0]);
    }
  });

  it("keeps every generated record labelled, simulated, and pending human review", () => {
    const directory = temporaryDirectory();
    generateInto(directory);
    const manifest = readManifest(directory);

    expect(manifest.review).toEqual({ pending: 240, passed: 0, failedAndRemoved: 0 });
    for (const document of manifest.documents) {
      expect(document.status).toBe("draft");
      expect(document.reviewStatus).toBe("pending");
      expect(document.simulated).toBe(true);
      expect(document.label).toBe("SYNTHETIC");
      const content = readFileSync(join(directory, document.contentPath), "utf8");
      expect(content).toContain("> SYNTHETIC — ");
      expect(content).toContain(document.language === "en"
        ? "Human review is pending"
        : "รอการทบทวนโดยบุคคล");
      if (document.revision === "A") {
        expect(document.supersededBy).not.toBeNull();
        expect(document.supersedes).toBeNull();
      } else {
        expect(document.supersedes).not.toBeNull();
        expect(document.supersededBy).toBeNull();
      }
    }
  });

  it("writes a distinct body for every document, with no unfilled placeholder", () => {
    const directory = temporaryDirectory();
    generateInto(directory);
    const manifest = readManifest(directory);

    const bodies = manifest.documents.map(({ contentPath }) => documentBody(directory, contentPath));
    expect(new Set(bodies).size).toBe(240);
    for (const body of bodies) {
      expect(body).not.toMatch(/\[[^\]]*\]|\{\w+\}/);
    }
  });

  it("matches the committed batch", () => {
    const directory = temporaryDirectory();
    const committed = resolve("data/synthetic/corpus");
    // Start from the committed checklist so recorded decisions are replayed.
    writeFileSync(
      join(directory, "review-checklist.csv"),
      readFileSync(join(committed, "review-checklist.csv"), "utf8"),
      "utf8",
    );
    generateInto(directory);

    const filenames = readdirSync(join(directory, "documents")).sort();
    expect(readdirSync(join(committed, "documents")).sort()).toEqual(filenames);
    for (const path of ["manifest.json", "review-checklist.csv", ...filenames.map((name) => `documents/${name}`)]) {
      expect(readFileSync(join(committed, path), "utf8"), path).toBe(readFileSync(join(directory, path), "utf8"));
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

  it("keeps recorded review decisions and removes failed documents on a rerun", () => {
    const directory = temporaryDirectory();
    generateInto(directory);
    recordDecisions(directory, {
      "SYN-UC1-PROC-EN-001-A": ["Reviewer One", "pass", "2026-10-11", "Clear, and labelled."],
      "SYN-UC1-PROC-EN-001-B": ["Reviewer One", "PASS", "2026-10-11", ""],
      "SYN-UC1-MEMO-TH-002-A": ["Reviewer Two", "pass", "2026-10-11", ""],
      "SYN-UC1-MEMO-TH-002-B": ["Reviewer Two", "fail", "2026-10-11", 'Unclear ""scope"", remove.'],
    });
    const reviewedChecklist = readFileSync(join(directory, "review-checklist.csv"), "utf8")
      .replace('"PASS"', '"pass"');

    generateInto(directory);
    const manifest = readManifest(directory);
    const byId = new Map(manifest.documents.map((document) => [document.documentId, document]));

    expect(readFileSync(join(directory, "review-checklist.csv"), "utf8")).toBe(reviewedChecklist);
    expect(manifest.review).toEqual({ pending: 236, passed: 3, failedAndRemoved: 1 });
    expect(manifest.documentCount).toBe(239);
    expect(byId.has("SYN-UC1-MEMO-TH-002-B")).toBe(false);
    expect(readdirSync(join(directory, "documents"))).not.toContain("syn-uc1-memo-th-002-b.md");
    expect(byId.get("SYN-UC1-PROC-EN-001-A")).toMatchObject({ status: "superseded", reviewStatus: "passed" });
    expect(byId.get("SYN-UC1-PROC-EN-001-B")).toMatchObject({ status: "current", reviewStatus: "passed" });
    expect(byId.get("SYN-UC1-MEMO-TH-002-A")).toMatchObject({ status: "current", supersededBy: null });
    expect(readFileSync(join(directory, "documents/syn-uc1-proc-en-001-b.md"), "utf8"))
      .toContain("Human review passed");
  });

  it.each([
    [["", "pass", "2026-10-11", ""], /requires a reviewer and reviewed_at/],
    [["Reviewer One", "maybe", "2026-10-11", ""], /must be "pass", "fail" or blank/],
  ])("rejects an incomplete or unknown review decision", (decision, expectedError) => {
    const directory = temporaryDirectory();
    generateInto(directory);
    recordDecisions(directory, { "SYN-UC1-ILI-EN-004-A": decision });

    expect(() => execFileSync(process.execPath, [generator, "--output-dir", directory], {
      cwd: repositoryRoot,
      stdio: "pipe",
    })).toThrow(expectedError);
  });

  it("rejects unsupported command-line arguments", () => {
    expect(() => execFileSync(process.execPath, [generator, "--unknown"], {
      cwd: repositoryRoot,
      stdio: "pipe",
    })).toThrow(/Unknown argument: --unknown/);
  });
});
