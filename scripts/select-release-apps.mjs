import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { APPS, appNeedsRelease } from "./release-selection.ts";

const revision = process.env.RELEASE_SHA;
const environment = process.env.RELEASE_ENV;
if (!/^[a-f0-9]{40}$/.test(revision ?? "") || !["dev", "demo"].includes(environment)) throw new Error("Invalid release identity");
const selected = [];
for (const app of APPS) {
  const service = `${app === "api" ? "web-api" : app}-${environment}`;
  // A failed cloud read is fatal. A missing/unknown deployment label rebuilds conservatively.
  const baseline = execFileSync("gcloud", ["run", "services", "describe", service,
    `--project=${process.env.GCP_PROJECT}`, `--region=${process.env.GCP_REGION}`,
    "--format=value(labels.fieldloop_release_revision)"], { encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/.test(baseline) || spawnSync("git", ["merge-base", "--is-ancestor", baseline, revision]).status !== 0) {
    selected.push(app);
    continue;
  }
  const changed = execFileSync("git", ["diff", "--name-only", "-z", baseline, revision], { encoding: "utf8" }).split("\0").filter(Boolean);
  const affected = JSON.parse(execFileSync("pnpm", ["exec", "turbo", "ls", "--affected", "--output=json"], {
    encoding: "utf8", env: { ...process.env, TURBO_SCM_BASE: baseline, TURBO_SCM_HEAD: revision },
  })).packages.items.map(item => item.name);
  if (appNeedsRelease(app, changed, affected)) selected.push(app);
}
appendFileSync(process.env.GITHUB_OUTPUT, `apps=${JSON.stringify(selected)}\ncount=${selected.length}\n`);
console.log(`Release images: ${selected.length ? selected.join(", ") : "none (deployed code unchanged)"}`);
