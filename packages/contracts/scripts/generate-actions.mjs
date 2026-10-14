import { mkdir, readFile, writeFile } from "node:fs/promises";
import { compile } from "json-schema-to-typescript";
const schema = JSON.parse(await readFile(new URL("../actions.v1.schema.json", import.meta.url), "utf8"));
const types = await compile(schema, "ActionContract", { additionalProperties: false, ignoreMinAndMaxItems: true });
await mkdir(new URL("../src/generated/", import.meta.url), { recursive: true });
await writeFile(new URL("../src/generated/actions.ts", import.meta.url), `${types}\nexport const actionSchema = ${JSON.stringify(schema, null, 2)} as const;\n`);
// Inline the same schemas for the source-backed API reference (which only permits local refs).
const { stringify } = await import("yaml");
const apiUrl = new URL("../openapi.yaml", import.meta.url);
let api = await readFile(apiUrl, "utf8");
const definitions = JSON.parse(JSON.stringify(schema.$defs).replaceAll("#/$defs/", "#/components/schemas/"));
const block = `    # BEGIN generated action schemas\n${stringify(definitions).trimEnd().split("\n").map(line => `    ${line}`).join("\n")}\n    # END generated action schemas`;
if (api.includes("    # BEGIN generated action schemas")) {
  api = api.replace(/ {4}# BEGIN generated action schemas[\s\S]*? {4}# END generated action schemas/, block);
} else {
  api = api.replace("  schemas:\n", `  schemas:\n${block}\n`);
}
await writeFile(apiUrl, api);
