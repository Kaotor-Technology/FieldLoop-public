import { readFile, writeFile } from "node:fs/promises";
import { parse } from "yaml";

const design = parse((await readFile(new URL("../../../DESIGN.md", import.meta.url), "utf8")).split("---")[1]);
const source = new URL("../src/styles.css", import.meta.url);
let css = (await readFile(source, "utf8")).replaceAll("--radius-", "--rounded-");
for (const [name, value] of Object.entries(design.spacing)) css = css.replaceAll(`@media (--${name})`, `@media (max-width: ${value})`);
const dark = [...css.matchAll(/:root\[data-theme="dark"\][^{]*\{[^}]*\}/g)].map(match => match[0].replaceAll(':root[data-theme="dark"]', ':root:not([data-theme="light"])')).join("\n");
css += `\n@media (prefers-color-scheme: dark) {\n${dark}\n}\n`;
await writeFile(new URL("../src/generated/styles.css", import.meta.url), css.replaceAll('"./generated/', '"./').replaceAll('@source "./**', '@source "../**'));
