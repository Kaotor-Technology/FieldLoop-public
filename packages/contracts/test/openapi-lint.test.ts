import { readFile, writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
      "fieldloop-csrf-on-unsafe-methods @ paths > /v1/things/{thingId}:archive > head > parameters",
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

// Mutations of a complete conforming contract prove the new rule independently.
describe("command idempotency", () => {
  const cases = [
    { name: "rejects a command without the header", exemption: "", rejects: true },
    { name: "rejects an empty exemption", exemption: '      x-idempotency-exempt: ""\n', rejects: true },
    { name: "accepts a documented stateless exemption", exemption: '      x-idempotency-exempt: "Pure calculation; no persistent effects."\n', rejects: false },
    { name: "rejects a boolean exemption", exemption: '      x-idempotency-exempt: true\n', rejects: true },
  ];
  for (const testCase of cases) {
    it(testCase.name, async () => {
      const fixture = resolve(packageRoot, "test/fixtures", `temporary-${randomUUID()}.yaml`);
      const source = (await readFile(resolve(packageRoot, "test/fixtures/conforming.yaml"), "utf8"))
        .replace('        - $ref: "../../openapi.yaml#/components/parameters/IdempotencyKey"\n', "")
        .replace("      operationId: acceptHealthProposal\n", `${testCase.exemption}      operationId: acceptHealthProposal\n`);
      try {
        await writeFile(fixture, source);
        const findings = (await lint(fixture)).filter((finding) => finding.code === "fieldloop-command-idempotency");
        expect(findings.length > 0).toBe(testCase.rejects);
      } finally {
        await unlink(fixture);
      }
    }, timeoutMs);
  }
});

async function lintMutation(transform: (source: string) => string): Promise<Finding[]> {
  const fixture = resolve(packageRoot, `test/fixtures/review-${randomUUID()}.yaml`);
  try {
    await writeFile(fixture, transform(await readFile(resolve(packageRoot, "test/fixtures/conforming.yaml"), "utf8")));
    return await lint(fixture);
  } finally {
    await unlink(fixture);
  }
}

describe("referenced error responses", () => {
  for (const response of ["Good", "Extended", "Alias", "BadInline", "BadLookAlike", "BadNamedProblem"]) {
    it(`validates external ${response} against the shared Problem`, async () => {
      const findings = await lintMutation((source) => source.replace(
        "../../openapi.yaml#/components/responses/BadRequest",
        `./referenced-errors.yaml#/components/responses/${response}`,
      ));
      if (response.startsWith("Bad")) {
        expect(findings.some((finding) => finding.code === "fieldloop-error-problem-schema")).toBe(true);
      } else {
        expect(findings).toEqual([]);
      }
    }, timeoutMs);
  }
});

describe("CSRF on every session non-GET operation", () => {
  for (const method of ["put", "post", "patch", "delete", "head", "options", "trace"]) {
    for (const hasHeader of [false, true]) {
      it(`${hasHeader ? "accepts" : "rejects"} session ${method} ${hasHeader ? "with" : "without"} CSRF`, async () => {
        const findings = await lintMutation((source) => {
          const changed = source.replace("    get:\n", `    ${method}:\n`);
          return hasHeader ? changed.replace("      parameters:\n", '      parameters:\n        - $ref: "../../openapi.yaml#/components/parameters/CsrfToken"\n') : changed;
        });
        if (hasHeader) expect(findings).toEqual([]);
        else expect(findings.some((finding) => finding.code === "fieldloop-csrf-on-unsafe-methods")).toBe(true);
      }, timeoutMs);
    }
  }
  for (const method of ["head", "options", "trace"]) {
    it(`accepts public ${method} without CSRF`, async () => {
      expect(await lintMutation((source) => source.replace("    get:\n", `    ${method}:\n      security: []\n`))).toEqual([]);
    }, timeoutMs);
  }
});
