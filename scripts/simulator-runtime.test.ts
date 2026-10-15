import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("./check-simulator-runtime.py", import.meta.url));
function check(env: Record<string, string>, network = true) {
  return spawnSync("python3", [script, "dev"], {
    input: JSON.stringify({ spec: { template: {
      metadata: { annotations: network ? {
        "run.googleapis.com/network-interfaces": JSON.stringify([{ network: "fixture", subnetwork: "fixture-dev" }]),
        "run.googleapis.com/vpc-access-egress": "private-ranges-only",
      } : {} },
      spec: { serviceAccountName: "simulator@fixture.iam.gserviceaccount.com", containers: [{
        env: Object.entries(env).map(([name, value]) => ({ name, value })),
      }] },
    } } }), encoding: "utf8",
  });
}
const configured = {
  FIELDLOOP_ENV: "dev", FIELDLOOP_DB_CONNECTION_NAME: "fixture:region:sql",
  FIELDLOOP_DB_NAME: "fieldloop_dev", FIELDLOOP_DB_USER: "simulator@fixture.iam",
};
describe("simulator release prerequisites", () => {
  it("rejects the deployed FL-316 missing-database configuration without echoing values", () => {
    const result = check({ FIELDLOOP_ENV: "dev" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("FIELDLOOP_DB_CONNECTION_NAME");
    expect(result.stderr).not.toContain("simulator@fixture");
  });
  it("accepts environment-specific IAM SQL over private VPC", () => expect(check(configured).status).toBe(0));
  it("rejects missing private SQL connectivity", () => expect(check(configured, false).status).not.toBe(0));
  it("rejects cross-environment databases", () => expect(check({ ...configured, FIELDLOOP_DB_NAME: "fieldloop_demo" }).status).not.toBe(0));
  it("rejects password database overrides in cloud runtimes", () => expect(check({ ...configured, FIELDLOOP_DATABASE_URL: "secret-fixture" }).status).not.toBe(0));
});
