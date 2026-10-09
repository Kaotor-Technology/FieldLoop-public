import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositories: string[] = [];
const checker = resolve("scripts/check-confidential-paths.mjs");
function repository() {
  const cwd = mkdtempSync(join(tmpdir(), "fieldloop-safety-"));
  repositories.push(cwd);
  execFileSync("git", ["init", "--quiet"], { cwd });
  return cwd;
}
function stagePath(cwd: string, path: string) {
  const hash = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd, input: "", encoding: "utf8" }).trim();
  execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${hash},${path}`], { cwd });
}
function check(cwd: string) {
  return spawnSync(process.execPath, [checker], { cwd, encoding: "utf8" });
}
afterEach(() => {
  for (const cwd of repositories.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe("confidential Git path boundary", () => {
  it("accepts an empty repository and safe synthetic paths", () => {
    const cwd = repository();
    expect(check(cwd).status).toBe(0);
    stagePath(cwd, "data/synthetic/route.geojson");
    stagePath(cwd, "docs/raw-data-policy.md");
    expect(check(cwd).status).toBe(0);
  });
  it.each(["raw-data/source.txt", "nested/raw-data/source.txt", "data/route.kmz", "data/route.KMZ", "RAW-DATA/source.txt", "raw-data"]) (
    "rejects staged metadata for %s without creating or opening the file", (path) => {
      const cwd = repository();
      stagePath(cwd, path);
      const result = check(cwd);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("prohibited Git path");
    },
  );
  it("rejects a forbidden HEAD path even when removed from the index", () => {
    const cwd = repository();
    stagePath(cwd, "raw-data/placeholder.txt");
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "test(FL-57): metadata fixture"], { cwd });
    execFileSync("git", ["update-index", "--force-remove", "raw-data/placeholder.txt"], { cwd });
    const result = check(cwd);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("prohibited Git path");
  });
  it("fails outside a Git repository", () => {
    const cwd = mkdtempSync(join(tmpdir(), "fieldloop-no-git-"));
    repositories.push(cwd);
    expect(check(cwd).status).not.toBe(0);
  });
  it("rejects prohibited paths added and removed in earlier commits", () => {
    const cwd = repository();
    stagePath(cwd, "data/placeholder.kmz");
    const commit = (message: string) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", message], { cwd });
    commit("test(FL-57): metadata fixture");
    execFileSync("git", ["update-index", "--force-remove", "data/placeholder.kmz"], { cwd });
    commit("test(FL-57): remove metadata fixture");
    const result = check(cwd);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("prohibited Git path");
  });
});
