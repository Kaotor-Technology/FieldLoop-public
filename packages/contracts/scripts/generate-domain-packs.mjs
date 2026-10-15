import { mkdir, readFile, writeFile } from "node:fs/promises";
import { compile } from "json-schema-to-typescript";

// The generator uses draft-07 tuple syntax; runtime validation keeps draft 2020-12.
function generatorSchema(value) {
  if (Array.isArray(value)) return value.map(generatorSchema);
  if (value === null || typeof value !== "object") return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, generatorSchema(child)]));
  if (result.prefixItems) {
    result.items = result.prefixItems;
    result.additionalItems = false;
    delete result.prefixItems;
  }
  return result;
}

for (const [file, typeName, schemaName] of [
  ["domain-pack", "DomainPack", "domainPackSchema"],
  ["agent-definition", "AgentDefinition", "agentDefinitionSchema"],
  ["gen-ai-safety", "GenAiSafetyPack", "genAiSafetySchema"],
]) {
  const schema = JSON.parse(await readFile(new URL(`../${file}.v1.schema.json`, import.meta.url), "utf8"));
  const types = await compile(generatorSchema(schema), typeName, { additionalProperties: false });
  await mkdir(new URL("../src/generated/", import.meta.url), { recursive: true });
  await writeFile(new URL(`../src/generated/${file}.ts`, import.meta.url), `${types}\nexport const ${schemaName} = ${JSON.stringify(schema, null, 2)} as const;\n`);
}
