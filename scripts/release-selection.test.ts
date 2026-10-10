import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APPS, appNeedsRelease } from "./release-selection.js";

function selected(files: string[], packages: string[] = []) {
  return APPS.filter(app => appNeedsRelease(app, files, packages));
}
describe("release image selection", () => {
  it("skips documentation and Terraform-only changes", () => {
    expect(selected(["docs/context.md", "infra/terraform/data.tf"])).toEqual([]);
  });
  it("rebuilds the API when its embedded SPA changes", () => {
    expect(selected(["apps/web/src/App.tsx"], ["@fieldloop/web"])).toEqual(["api"]);
  });
  it("includes transitive shared package consumers reported by Turbo", () => {
    expect(selected(["packages/contracts/src/index.ts"], ["@fieldloop/contracts", "@fieldloop/guardrail", "@fieldloop/signal-worker"])).toEqual(["guardrail", "signal-worker"]);
  });
  it("includes all unreleased changes rather than only the most recent commit", () => {
    expect(selected(["apps/assistant/src/main.py", "docs/context.md"])).toEqual(["assistant"]);
  });
  it("rebuilds both Python consumers for shared code or lock changes", () => {
    expect(selected(["py/fieldloop_common/src/types.py"])).toEqual(["assistant", "simulator"]);
    expect(selected(["uv.lock"])).toEqual(["assistant", "simulator"]);
  });
  it("rebuilds TS containers on workspace installation input changes", () => {
    expect(selected(["pnpm-lock.yaml"])).toEqual(["api", "guardrail", "signal-worker"]);
  });
  it("rebuilds every image when Docker context filtering changes", () => {
    expect(selected([".dockerignore"])).toEqual([...APPS]);
  });
});

// Exercise the real CLI boundary, including Git history and failing cloud reads.
const repositories: string[] = [];
const cli = resolve("scripts/select-release-apps.mjs");
afterEach(() => {
  for (const cwd of repositories.splice(0)) rmSync(cwd, { recursive: true, force: true });
});
function releaseRepository() {
  const cwd = mkdtempSync(join(tmpdir(), "fieldloop-release-"));
  repositories.push(cwd);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Release fixture");
  git("commit", "--allow-empty", "-m", "deployed");
  const baseline = git("rev-parse", "HEAD");
  mkdirSync(join(cwd, "apps/api"), { recursive: true });
  writeFileSync(join(cwd, "apps/api/change.txt"), "unreleased code");
  git("add", "apps"); git("commit", "-m", "application change");
  writeFileSync(join(cwd, "README.md"), "latest commit contains only docs");
  git("add", "README.md"); git("commit", "-m", "docs");
  const revision = git("rev-parse", "HEAD");
  const bin = join(cwd, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "gcloud"), '#!/bin/sh\nif [ "$CLOUD_CASE" = failure ]; then exit 1; fi\nif [ "$CLOUD_CASE" = known ]; then printf "%s" "$DEPLOYED_BASE"; fi\n', { mode: 0o755 });
  writeFileSync(join(bin, "pnpm"), `#!/bin/sh
[ "$TURBO_SCM_BASE" = "$DEPLOYED_BASE" ] && [ "$TURBO_SCM_HEAD" = "$RELEASE_SHA" ] || exit 2
printf '{"packages":{"items":[]}}'
`, { mode: 0o755 });
  const output = join(cwd, "output");
  const run = (cloudCase: string) => spawnSync(process.execPath, [cli], { cwd, encoding: "utf8", env: {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, RELEASE_SHA: revision, RELEASE_ENV: "dev",
    DEPLOYED_BASE: baseline, CLOUD_CASE: cloudCase, GITHUB_OUTPUT: output,
    GCP_PROJECT: "fixture", GCP_REGION: "asia-southeast1",
  } });
  return { run, output };
}
describe("release selection cloud/Git boundary", () => {
  it("uses the deployed baseline across multiple commits", () => {
    const fixture = releaseRepository();
    expect(fixture.run("known").status).toBe(0);
    expect(readFileSync(fixture.output, "utf8")).toContain('apps=["api"]');
  });
  it("rebuilds all images when no deployment baseline exists", () => {
    const fixture = releaseRepository();
    expect(fixture.run("missing").status).toBe(0);
    expect(readFileSync(fixture.output, "utf8")).toContain("count=5");
  });
  it("fails rather than treating a cloud permission/network error as no changes", () => {
    expect(releaseRepository().run("failure").status).not.toBe(0);
  });
});
