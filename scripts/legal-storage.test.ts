import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function runCase(mode: string) {
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", `
    import { uploadCorpus } from './db/seed/legal-corpus/upload.mjs';
    import { readManifest, validateStorage } from './db/seed/legal-corpus/seed.mjs';
    const manifest = readManifest();
    // Only the two committed CFR XML snapshots need no PDF source cache.
    manifest.records = manifest.records.filter(r => r.documentKey.startsWith('US-'));
    manifest.recordCount = manifest.records.length;
    const writes = [];
    const store = { async put(name, bytes) {
      writes.push({ name, size: bytes.length });
      if (process.argv[1] === 'failure') throw new Error('fixture storage unavailable');
      return 'gs://fixture-docs/' + name;
    } };
    let report = null, error = null;
    try {
      report = await uploadCorpus(store, 'fixture-docs', manifest);
      if (process.argv[1] === 'revision') report.records[0].revision = 'wrong revision';
      if (process.argv[1] === 'hash') report.records[0].contentSha256 = 'wrong hash';
      if (process.argv[1] === 'eligibility') report.records[0].indexingEligibility = 'quarantined';
      if (process.argv[1] === 'missing') report.records.pop();
      validateStorage(manifest, report);
    } catch (failure) { error = failure.message; }
    console.log(JSON.stringify({ writes, report, error }));
  `, mode], { cwd: resolve("."), encoding: "utf8" })) as {
    writes: { name: string; size: number }[];
    report: { records: unknown[] } | null;
    error: string | null;
  };
}

describe("legal source storage handoff", () => {
  it("binds uploaded content to the revision and source hash", () => {
    const result = runCase("success");
    expect(result.error).toBeNull();
    expect(result.writes).toHaveLength(2);
    expect(result.writes.every((write) => write.size > 0)).toBe(true);
    expect(result.report?.records).toHaveLength(2);
  });

  it.each(["revision", "hash", "eligibility", "missing"])("rejects a %s mismatch before DB loading", (mode) => {
    expect(runCase(mode).error).toMatch(/mismatch|Missing stored full text/);
  });

  it("does not produce a handoff after a storage failure", () => {
    const result = runCase("failure");
    expect(result.error).toBe("fixture storage unavailable");
    expect(result.report).toBeNull();
  });
});
