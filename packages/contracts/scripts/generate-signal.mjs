import { mkdir, readFile, writeFile } from "node:fs/promises";
import { compile } from "json-schema-to-typescript";

const schema = JSON.parse(await readFile(new URL("../signal.v1.schema.json", import.meta.url), "utf8"));
const types = await compile(schema, "Signal", { additionalProperties: false });
await mkdir(new URL("../src/generated/", import.meta.url), { recursive: true });
await writeFile(new URL("../src/generated/signal.ts", import.meta.url), `${types}\nexport const signalSchema = ${JSON.stringify(schema, null, 2)} as const;\n`);
