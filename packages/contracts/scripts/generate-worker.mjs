import { readFile, writeFile, mkdir } from "node:fs/promises";
import { compile } from "json-schema-to-typescript";

await mkdir(new URL("../src/generated/", import.meta.url), { recursive: true });
for (const [name, type] of [["registered-signal-rule", "RegisteredSignalRule"], ["worker-event", "WorkerEvent"]]) {
  const schema = JSON.parse(await readFile(new URL(`../${name}.v1.schema.json`, import.meta.url), "utf8"));
  const types = await compile(schema, type, { additionalProperties: false });
  await writeFile(new URL(`../src/generated/${name}.ts`, import.meta.url), `${types}\nexport const schema = ${JSON.stringify(schema)} as const;\n`);
}

const api = JSON.parse(await readFile(new URL("../signal-worker.v1.openapi.json", import.meta.url), "utf8"));
await writeFile(new URL("../src/generated/push-schema.ts", import.meta.url), `export const pushSchema = ${JSON.stringify(api.components.schemas.PubSubPush)} as const;\n`);
