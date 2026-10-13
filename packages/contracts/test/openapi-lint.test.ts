import { readdirSync } from "node:fs";
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

function lint(document: string, ruleset = ".spectral.yaml"): Promise<Finding[]> {
  return new Promise((resolveFindings, reject) => {
    execFile(
      process.execPath,
      [spectralCli, "lint", document, "--ruleset", ruleset, "--format", "json", "--quiet"],
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

// The simulator's mock-source contracts follow `.spectral.mock.yaml`. Mutations of a
// real contract prove each of its rules independently, as for the platform contract.
const mockRuleset = ".spectral.mock.yaml";
const mockContracts = readdirSync(packageRoot)
  .filter((name) => name.endsWith(".openapi.json"))
  .sort();
const mockPath = "/mock/historian/tags/{tag}";

interface MockOperation {
  security?: unknown[];
  responses: Record<string, unknown>;
  [key: string]: unknown;
}

type MockPathItem = Record<string, MockOperation>;

interface MockContract {
  security: unknown;
  paths: Record<string, MockPathItem>;
  components: { securitySchemes: Record<string, unknown> };
}

function pathItem(contract: MockContract): MockPathItem {
  const item = contract.paths[mockPath];
  if (item === undefined) throw new Error(`mock-historian.v1.openapi.json no longer defines ${mockPath}`);
  return item;
}

function operation(contract: MockContract): MockOperation {
  const found = pathItem(contract).get;
  if (found === undefined) throw new Error(`${mockPath} no longer defines get`);
  return found;
}

async function lintMockMutation(mutate: (contract: MockContract) => void): Promise<Finding[]> {
  // The temporary file sits beside openapi.yaml, where a mock contract's references resolve.
  const fixture = resolve(packageRoot, `temporary-${randomUUID()}.json`);
  const contract = JSON.parse(await readFile(resolve(packageRoot, "mock-historian.v1.openapi.json"), "utf8")) as MockContract;
  mutate(contract);
  try {
    await writeFile(fixture, JSON.stringify(contract));
    return await lint(fixture, mockRuleset);
  } finally {
    await unlink(fixture);
  }
}

function replaceNotFound(response: unknown): (contract: MockContract) => void {
  return (contract) => {
    operation(contract).responses["404"] = response;
  };
}

const mockViolations: { name: string; rule: string; mutate: (contract: MockContract) => void }[] = [
  {
    name: "a path outside /mock/",
    rule: "fieldloop-mock-path-prefix",
    mutate: (contract) => {
      contract.paths = Object.fromEntries(
        Object.entries(contract.paths).map(([name, item]) => [name === mockPath ? "/v1/historian/tags/{tag}" : name, item]),
      );
    },
  },
  {
    name: "a write method",
    rule: "fieldloop-mock-get-only",
    mutate: (contract) => {
      pathItem(contract).put = { ...operation(contract), operationId: "replaceMockHistorianTag" };
    },
  },
  {
    name: "the cookie session as the default security",
    rule: "fieldloop-mock-service-identity-security",
    mutate: (contract) => {
      contract.security = [{ sessionCookie: [] }];
    },
  },
  {
    name: "a public operation",
    rule: "fieldloop-mock-no-operation-security",
    mutate: (contract) => {
      operation(contract).security = [];
    },
  },
  {
    name: "a cookie session scheme beside the service identity",
    rule: "fieldloop-mock-service-identity-scheme",
    mutate: (contract) => {
      contract.components.securitySchemes.sessionCookie = { type: "apiKey", in: "cookie", name: "fl_session" };
    },
  },
  {
    name: "a service identity that is not a bearer token",
    rule: "fieldloop-mock-service-identity-scheme",
    mutate: (contract) => {
      contract.components.securitySchemes.serviceIdentity = { type: "http", scheme: "basic" };
    },
  },
  {
    name: "an inline look-alike of Problem",
    rule: "fieldloop-mock-error-problem-ref",
    mutate: replaceNotFound({
      description: "Unknown tag.",
      content: { "application/problem+json": { schema: { type: "object", properties: { title: { type: "string" } } } } },
    }),
  },
  {
    name: "an error body from another file",
    rule: "fieldloop-mock-error-problem-ref",
    mutate: replaceNotFound({
      description: "Unknown tag.",
      content: { "application/problem+json": { schema: { $ref: "mock-historian.v1.schema.json" } } },
    }),
  },
  {
    name: "an error response taken from another contract",
    rule: "fieldloop-mock-error-problem-ref",
    mutate: replaceNotFound({
      $ref: "mock-patrol.v1.openapi.json#/paths/~1mock~1patrol~1findings/get/responses/405",
    }),
  },
];

describe("FieldLoop mock-source conventions", () => {
  it("lints every JSON OpenAPI contract of the package as a mock source", () => {
    expect(mockContracts.length).toBeGreaterThan(0);
    expect(mockContracts.filter((name) => !/^mock-.+\.openapi\.json$/.test(name))).toEqual([]);
  });

  it("runs from pnpm lint:api", async () => {
    const { scripts } = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(scripts["lint:openapi"]).toContain(`lint "mock-*.openapi.json" --ruleset ${mockRuleset}`);
  });

  for (const contract of mockContracts) {
    it(`accepts ${contract}`, async () => {
      expect(await lint(contract, mockRuleset)).toEqual([]);
    }, timeoutMs);
  }

  it("accepts an error response that references a shared response", async () => {
    const findings = await lintMockMutation(replaceNotFound({ $ref: "openapi.yaml#/components/responses/NotFound" }));
    expect(findings).toEqual([]);
  }, timeoutMs);

  for (const { name, rule, mutate } of mockViolations) {
    it(`rejects ${name}`, async () => {
      const findings = await lintMockMutation(mutate);
      expect(findings.map((finding) => finding.code)).toContain(rule);
    }, timeoutMs);
  }

  it("keeps the base conventions that do not depend on the session", async () => {
    const findings = await lintMockMutation((contract) => {
      operation(contract).operationId = "read_mock_tag";
    });
    expect(findings.map((finding) => finding.code)).toContain("fieldloop-operation-id-camel-case");
  }, timeoutMs);
});
