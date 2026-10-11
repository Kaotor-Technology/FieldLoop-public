import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parse } from "yaml";

const designUrl = new URL("../../../DESIGN.md", import.meta.url);
const design = await readFile(designUrl, "utf8");
const tokens = parse(design.split("---")[1]);
const css = execFileSync("design.md", ["export", designUrl.pathname, "--format", "css-vars"], { encoding: "utf8" });
const properties = [];
for (const [name, typography] of Object.entries(tokens.typography)) {
  for (const [property, value] of Object.entries(typography)) {
    const kebabProperty = property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    properties.push(`  --type-${name}-${kebabProperty}: ${property === "fontFamily" ? JSON.stringify(value) : value};`);
  }
}
const generated = `/* Generated from DESIGN.md; do not edit. */\n${css}\n:root {\n${properties.join("\n")}\n}\n`;
for (const destination of ["../src/generated/", "../dist/"]) {
  const directory = new URL(destination, import.meta.url);
  await mkdir(directory, { recursive: true });
  await writeFile(new URL("tokens.css", directory), generated);
}
