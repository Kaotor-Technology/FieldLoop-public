import { execFileSync, spawnSync } from "node:child_process";

// Inspect Git path metadata only. Never open the prohibited files.
const paths = execFileSync("git", ["ls-files", "--cached", "-z"], { encoding: "utf8" });
const head = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { encoding: "utf8" });
if (head.status !== 0 && head.status !== 128) {
  throw new Error("Cannot resolve Git HEAD");
}
const committed = head.status === 0
  ? execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", "HEAD"], { encoding: "utf8" })
  : "";
const forbidden = new Set((paths + committed).split("\0").filter((path) =>
  /(^|\/)raw-data(\/|$)/i.test(path) || /\.kmz$/i.test(path),
));
if (forbidden.size > 0) {
  console.error(`Confidential path check failed: ${forbidden.size} prohibited Git path(s).`);
  process.exitCode = 1;
} else {
  console.log("Confidential path check passed (HEAD and index).");
}
