import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { parse } from "yaml";
// The build entry point is also exercised directly by the CI reference job.
import { renderReference } from "../scripts/reference.mjs";

it("renders every implemented operation, shared schema and the exact source hash", async () => {
  const source = await readFile(new URL("../openapi.yaml", import.meta.url), "utf8");
  const spec = parse(source);
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const html = renderReference(spec, sourceHash);
  for (const [path, item] of Object.entries<Record<string, { operationId: string }>>(spec.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      expect(html).toContain(`${method.toUpperCase()} ${path}`);
      expect(html).toContain(operation.operationId);
    }
  }
  expect(html).toContain("schemas / Problem");
  expect(html).toContain("sessionCookie");
  expect(html).toContain(sourceHash);
  expect(html).not.toMatch(/<script[^>]+src=["']https?:/);
});

it("escapes hostile spec prose and examples, and renders inherited parameters and public security overrides", () => {
  const spec = {
    info: { title: '<script>alert("synthetic")</script>', version: "synthetic-test" },
    security: [{ sessionCookie: [] }],
    paths: { "/v1/synthetic": { parameters: [{ name: "cursor", in: "query" }], get: { security: [], responses: { "200": { description: "<img src=x onerror=alert(1)>" } } } } },
  };
  const html = renderReference(spec, "test-hash");
  expect(html).not.toContain('<script>alert("synthetic")</script>');
  expect(html).not.toContain("<img src=x");
  expect(html).toContain("&lt;img src=x");
  expect(html).toContain("cursor");
  expect(html).toContain('&quot;security&quot;: []');
});

it("links every local reference to a real target and fails on unresolved or remote refs", () => {
  const spec = { info: { title: "Synthetic API", version: "test" }, components: { schemas: { Recursive: { properties: { child: { $ref: "#/components/schemas/Recursive" } } } } } };
  const html = renderReference(spec, "test-hash");
  for (const [, target] of html.matchAll(/href="#(ref-[^"]+)"/g)) expect(html).toContain(`id="${target}"`);
  expect(() => renderReference({ ...spec, paths: { "/missing": { $ref: "#/missing" } } }, "test")).toThrow("Unresolved reference");
  expect(() => renderReference({ ...spec, components: { schemas: { Remote: { $ref: "https://example.test/synthetic.json" } } } }, "test")).toThrow("Only local references");
});
