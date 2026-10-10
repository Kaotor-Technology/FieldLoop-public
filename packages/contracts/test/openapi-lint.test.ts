import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const spectralCli = resolve(dirname(require.resolve("@stoplight/spectral-cli/package.json")), "dist/index.js");

interface Finding {
  code: string;
  path: string[];
}

function lint(document: string): Promise<Finding[]> {
  return new Promise((resolveFindings, reject) => {
    execFile(
      process.execPath,
      [spectralCli, "lint", document, "--ruleset", ".spectral.yaml", "--format", "json", "--quiet"],
      { cwd: packageRoot },
      (error, stdout, stderr) => {
        // Spectral exits 1 when it reports findings; anything without JSON output is a real failure.
        if (stdout.trim() === "") {
          reject(error ?? new Error(stderr));
          return;
        }
        resolveFindings(JSON.parse(stdout) as Finding[]);
      },
    );
  });
}

const timeoutMs = 30_000;

describe("FieldLoop OpenAPI conventions", () => {
  it("accepts the base spec", async () => {
    expect(await lint("openapi.yaml")).toEqual([]);
  }, timeoutMs);

  it("accepts paths that follow every convention", async () => {
    expect(await lint("test/fixtures/conforming.yaml")).toEqual([]);
  }, timeoutMs);

  it("reports each broken convention at the place that breaks it", async () => {
    const findings = await lint("test/fixtures/violations.yaml");
    const reported = findings
      .filter((finding) => finding.code.startsWith("fieldloop-"))
      .map((finding) => `${finding.code} @ ${finding.path.join(" > ")}`)
      .sort();

    expect(reported).toEqual([
      "fieldloop-command-post-only @ paths > /v1/things/{thingId}:archive",
      "fieldloop-command-post-only @ paths > /v1/things/{thingId}:archive > get",
      "fieldloop-command-post-only @ paths > /v1/things/{thingId}:archive > head",
      "fieldloop-csrf-on-unsafe-methods @ paths > /auth/things > delete",
      "fieldloop-csrf-on-unsafe-methods @ paths > /v1/things > post",
      "fieldloop-error-problem-json @ paths > /v1/Health_Proposals > get > responses > 404 > content",
      "fieldloop-error-problem-json @ paths > /v1/things/{thingId}:archive > head > responses > 500 > content",
      "fieldloop-error-problem-schema @ paths > /v1/Health_Proposals > get > responses > 400 > content > application/problem+json > schema",
      "fieldloop-global-session-security @ security > 0",
      "fieldloop-no-browser-token-scheme @ components > securitySchemes > oauth",
      "fieldloop-no-default-response @ paths > /v1/Health_Proposals > get > responses > default",
      "fieldloop-openapi-3-1 @ openapi",
      "fieldloop-operation-id-camel-case @ paths > /v1/Health_Proposals > get > operationId",
      "fieldloop-path-kebab-case @ paths > /v1/Health_Proposals",
      "fieldloop-path-prefix @ paths > /api/things",
      "fieldloop-property-camel-case @ paths > /v1/Health_Proposals > get > responses > 200 > content > application/json > schema > allOf > 0 > properties > payload_hash",
      "fieldloop-property-camel-case @ paths > /v1/Health_Proposals > get > responses > 200 > content > application/json > schema > allOf > 1 > properties > next_cursor",
      "fieldloop-query-camel-case @ paths > /v1/Health_Proposals > get > parameters > 0 > name",
      "fieldloop-session-cookie-scheme @ components > securitySchemes > sessionCookie > name",
    ]);
  }, timeoutMs);
});
