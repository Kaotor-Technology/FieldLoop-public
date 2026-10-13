import { mkdir, readFile, writeFile } from "node:fs/promises";
import { compile } from "json-schema-to-typescript";

const schema = JSON.parse(await readFile(new URL("../signal.v1.schema.json", import.meta.url), "utf8"));
const types = await compile(schema, "Signal", { additionalProperties: false });
await mkdir(new URL("../src/generated/", import.meta.url), { recursive: true });
await writeFile(new URL("../src/generated/signal.ts", import.meta.url), `${types}\nexport const signalSchema = ${JSON.stringify(schema, null, 2)} as const;\n`);
const simulation = JSON.parse(await readFile(new URL("../simulation.v1.schema.json", import.meta.url), "utf8"));
await writeFile(new URL("../src/generated/simulation-schema.ts", import.meta.url), `// Generated from simulation.v1.schema.json.\nexport const simulationSchema = ${JSON.stringify(simulation, null, 2)} as const;\n`);
