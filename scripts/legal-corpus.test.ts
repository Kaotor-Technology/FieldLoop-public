import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

type SeedQuery = { sql: string; parameters: unknown[] };
type TransactionResult = {
  queries: SeedQuery[];
  connections: number;
  releases: number;
  ended: boolean;
  error: string | null;
};
type LegalRecord = {
  documentKey: string;
  titleTh: string | null;
  sourceUrls: string[];
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

function runSeedTransaction(failAt: number, zeroRowsAt = 0): TransactionResult {
  // Exercise Kysely's PostgreSQL driver without connecting to a database.
  const script = `
    import { Kysely, PostgresDialect } from 'kysely';
    import { loadSeed, readManifest } from './data/corpus/legal/seed.mjs';
    const queries = [];
    let connections = 0, releases = 0, ended = false, error = null;
    const client = {
      async query(sql, parameters) {
        queries.push({ sql, parameters });
        if (queries.length === Number(process.argv[1])) {
          throw new Error('injected seed failure');
        }
        return { rows: [], rowCount: queries.length === Number(process.argv[2]) ? 0 : 1, command: 'INSERT' };
      },
      release() { releases += 1; },
    };
    const pool = {
      async connect() { connections += 1; return client; },
      async end() { ended = true; },
    };
    const database = new Kysely({ dialect: new PostgresDialect({ pool }) });
    try {
      await loadSeed(database, readManifest(), "demo'pipeline");
    } catch (failure) {
      error = failure.message;
    } finally {
      await database.destroy();
    }
    console.log(JSON.stringify({ queries, connections, releases, ended, error }));
  `;
  return JSON.parse(execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", script, String(failAt), String(zeroRowsAt)],
    { cwd: repositoryRoot, encoding: "utf8" },
  )) as TransactionResult;
}

function validationError(manifest: LegalManifest): string {
  return execFileSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `import { validateManifest } from ${JSON.stringify(pathToFileURL(seeder).href)};\n` +
      `const manifest = JSON.parse(${JSON.stringify(JSON.stringify(manifest))});\n` +
      `try { validateManifest(manifest); process.exit(2); } catch (error) { console.log(error.message); }`,
  ], { cwd: repositoryRoot, encoding: "utf8" });
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

  it("lists every Thai record under its title in the research note", () => {
    const researchNote = readFileSync(resolve("docs/research/thai-laws-demo-corpus.md"), "utf8");
    const thaiRecords = readManifest().records.filter(({ documentKey }) => documentKey.startsWith("TH-"));

    for (const record of thaiRecords.filter(({ titleTh }) => titleTh !== null)) {
      expect(researchNote, record.documentKey).toContain(record.titleTh);
    }
  });

  it("links only to public-agency sources, not to an Organisation's website", () => {
    for (const record of readManifest().records) {
      for (const sourceUrl of record.sourceUrls) {
        expect(new URL(sourceUrl).hostname, record.documentKey).toMatch(/\.(go\.th|or\.th|gov)$/);
      }
    }
  });

  it("includes full source XML snapshots for 49 CFR Parts 192 and 195", () => {
    const records = readManifest().records;

    for (const part of ["192", "195"]) {
      const record = records.find(({ documentKey }) => documentKey === `US-49-CFR-${part}`);
      if (!record || typeof record.contentPath !== "string") {
        throw new Error("Both CFR records must point to a source snapshot.");
      }
      expect(record.contentState).toBe("full_text_snapshot");
      const snapshot = readFileSync(resolve("data/corpus/legal", record.contentPath), "utf8");
      expect(snapshot).toContain(`PART ${part}—`);
      expect(snapshot).toContain(`§ ${part}.1`);
    }
  });

  it("creates parameterized public Controlled Document records without a database connection", () => {
    const manifest = readManifest();
    const queries = previewSeed("demo'pipeline");

    expect(queries).toHaveLength(manifest.recordCount);
    for (const query of queries) {
      expect(query.sql).toContain('"app"."controlled_document"');
      expect(query.sql).toContain("on conflict");
      expect(query.parameters).toContain("demo'pipeline");
      expect(query.parameters).toContain("PUBLIC");
      expect(query.parameters).toContain(false);
      expect(query.parameters).toContain(null);
      const updateClause = query.sql.split(" do update set ")[1];
      if (!updateClause) {
        throw new Error("Seed query must update metadata on conflict.");
      }
      // Only a record that is still unverified takes its status from the manifest.
      expect(updateClause).toContain(
        '"status" = case when "controlled_document"."status" = $13 then "excluded"."status" else "controlled_document"."status" end',
      );
      expect(query.parameters[12]).toBe("status unverified");
      expect(updateClause).not.toContain('"blob_uri"');
      expect(updateClause).not.toContain('"superseded_by"');
    }

    // The sixth bound value is the inserted status.
    const statuses = queries.map(({ parameters }) => parameters[5]);
    expect(statuses.filter((status) => status === "status unverified")).toHaveLength(8);
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

    const validation = validationError(manifest);
    expect(validation).toContain("must require review and remain metadata-only");
  });

  it("rejects an unknown content state and a missing snapshot file", () => {
    const unknownState = readManifest();
    const missingFile = readManifest();
    const firstUnknown = unknownState.records[0];
    const part192 = missingFile.records.find(({ documentKey }) => documentKey === "US-49-CFR-192");
    if (!firstUnknown || !part192) {
      throw new Error("Expected legal records to mutate.");
    }
    firstUnknown.contentState = "summary";
    part192.contentPath = "documents/absent.xml";

    expect(validationError(unknownState)).toContain("has an unknown contentState");
    expect(validationError(missingFile)).toContain("points to a missing file");
  });

  it("rolls back when an existing document has a different immutable revision", () => {
    const result = runSeedTransaction(0, 2);
    expect(result.error).toMatch(/revision cannot change in place/);
    expect(result.queries.at(-1)?.sql).toBe("rollback");
    expect(result.queries.some(({ sql }) => sql === "commit")).toBe(false);
  });

  it("loads every record in one transaction and rolls back on failure", () => {
    const loaded = runSeedTransaction(0);
    expect(loaded.error).toBeNull();
    expect(loaded.connections).toBe(1);
    expect(loaded.releases).toBe(1);
    expect(loaded.queries.map(({ sql }) => sql).filter((sql) => !sql.startsWith("insert")))
      .toEqual(["begin", "commit"]);
    expect(loaded.queries).toHaveLength(20);

    const failed = runSeedTransaction(4);
    expect(failed.error).toBe("injected seed failure");
    expect(failed.queries.at(-1)?.sql).toBe("rollback");
    expect(failed.queries.some(({ sql }) => sql === "commit")).toBe(false);
  });
});
