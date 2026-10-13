import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parse } from "yaml";
import { fileURLToPath } from "node:url";

const designUrl = new URL("../../../DESIGN.md", import.meta.url);
const design = await readFile(designUrl, "utf8");
const tokens = parse(design.split("---")[1]);
const css = execFileSync("design.md", ["export", fileURLToPath(designUrl), "--format", "css-vars"], { encoding: "utf8" });
const properties = [];
for (const [name, value] of Object.entries(tokens.elevation)) properties.push(`  --elevation-${name}: ${value};`);
for (const [name, value] of Object.entries(tokens.motion["duration-ms"])) properties.push(`  --motion-${name}: ${value}ms;`);
for (const [name, value] of Object.entries(tokens.motion.easing)) properties.push(`  --ease-${name}: ${value};`);
for (const [name, typography] of Object.entries(tokens.typography)) {
  for (const [property, value] of Object.entries(typography)) {
    const kebabProperty = property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    properties.push(`  --type-${name}-${kebabProperty}: ${property === "fontFamily" ? JSON.stringify(value) : value};`);
  }
}
const generated = `/* Generated from DESIGN.md; do not edit. */\n${css}\n:root {\n${properties.join("\n")}\n}\n`;
const theme = execFileSync("design.md", ["export", fileURLToPath(designUrl), "--format", "css-tailwind"], { encoding: "utf8" });
for (const destination of ["../src/generated/", "../dist/"]) {
  const directory = new URL(destination, import.meta.url);
  await mkdir(directory, { recursive: true });
  await writeFile(new URL("tokens.css", directory), generated);
  await writeFile(new URL("theme.css", directory), theme);
}
