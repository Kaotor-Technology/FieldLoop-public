import { mkdir, readFile, writeFile } from "node:fs/promises";
import { compile } from "json-schema-to-typescript";

const schema = JSON.parse(await readFile(new URL("../risk.v1.schema.json", import.meta.url), "utf8"));
// Runtime validation enforces array sizes; callers can build inputs with map/filter.
const types = await compile(schema, "RiskContract", { additionalProperties: false, ignoreMinAndMaxItems: true });
await mkdir(new URL("../src/generated/", import.meta.url), { recursive: true });
await writeFile(new URL("../src/generated/risk.ts", import.meta.url), `${types}\nexport const riskSchema = ${JSON.stringify(schema, null, 2)} as const;\n`);
