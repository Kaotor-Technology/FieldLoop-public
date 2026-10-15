import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { expect, it } from "vitest";

type Node = { [key: string]: unknown };
const spec = parse(readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8"));
const methods = new Set(["get", "post", "put", "patch", "delete"]);
const resolve = (node: Node): Node => typeof node.$ref === "string"
  ? node.$ref.slice(2).split("/").reduce((value: Node, key: string) => value[key.replace(/~1/g, "/").replace(/~0/g, "~")] as Node, spec)
  : node;
const cases: [string, Node][] = [];
for (const [path, item] of Object.entries(spec.paths as Record<string, Node>)) {
  for (const [method, raw] of Object.entries(item)) {
    if (!methods.has(method)) continue;
    const operation = raw as Node;
    if (operation.requestBody) cases.push([`${method} ${path} request`, resolve(operation.requestBody as Node)]);
    for (const [code, response] of Object.entries(operation.responses as Node)) cases.push([`${method} ${path} ${code}`, resolve(response as Node)]);
  }
}
const mediaCases = cases.flatMap(([name, body]) => Object.entries((body.content ?? {}) as Record<string, Node>)
  .filter(([type]) => type === "application/json" || type === "application/problem+json")
  .map(([type, media]): [string, Node] => [`${name} ${type}`, media]));
it.each(mediaCases)("publishes schema-valid synthetic examples for %s", (name, media) => {
  const examples = media.example === undefined ? Object.values((media.examples ?? {}) as Record<string, { value: unknown }>).map(example => example.value) : [media.example];
  expect(examples.length).toBeGreaterThan(0);
  const ajv = new Ajv2020({ strict: false });
  addFormats.default(ajv);
  ajv.addSchema(spec, "urn:fieldloop:reference");
  // The enclosing OpenAPI document supplies each component reference's base.
  const schema = JSON.parse(JSON.stringify(media.schema).replaceAll('"#/components/', '"urn:fieldloop:reference#/components/'));
  const validate = ajv.compile(schema);
  for (const example of examples) {
    expect({ valid: validate(example), errors: validate.errors }).toEqual({ valid: true, errors: null });
    if (name.endsWith("application/problem+json") && example && typeof example === "object" && "status" in example) {
      expect(example.status).toBe(Number(name.split(" ").at(-2)));
    }
  }
});
