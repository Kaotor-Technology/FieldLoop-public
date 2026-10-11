import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const anchor = (value) => `ref-${Buffer.from(value).toString("hex")}`;

// Render the complete contract as escaped data. No Markdown/HTML from the spec executes.
export function renderReference(spec, sourceHash) {
  const references = new Set();
  function resolve(reference) {
    if (!reference.startsWith("#/")) throw new Error(`Only local references are supported: ${reference}`);
    const result = reference.slice(2).split("/").reduce((value, key) => value?.[decodeURIComponent(key).replace(/~1/g, "/").replace(/~0/g, "~")], spec);
    if (result === undefined) throw new Error(`Unresolved reference: ${reference}`);
    references.add(reference);
    return result;
  }
  function json(value) {
    return `<pre>${escapeHtml(JSON.stringify(value, null, 2)).replace(/&quot;\$ref&quot;: &quot;([^\n]+?)&quot;/g, (match, encoded) => {
      const reference = encoded.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      resolve(reference);
      return `<a href="#${anchor(reference)}">${match}</a>`;
    })}</pre>`;
  }
  const operations = [];
  for (const [path, rawItem] of Object.entries(spec.paths ?? {})) {
    const item = rawItem.$ref ? { ...resolve(rawItem.$ref), ...rawItem } : rawItem;
    for (const [method, operation] of Object.entries(item)) {
      if (!METHODS.has(method)) continue;
      const label = `${method.toUpperCase()} ${path}`;
      const inherited = { servers: item.servers ?? spec.servers ?? [], security: spec.security ?? [], ...operation };
      const parameters = new Map();
      for (const parameter of [...(item.parameters ?? []), ...(operation.parameters ?? [])]) {
        const resolved = parameter.$ref ? resolve(parameter.$ref) : parameter;
        parameters.set(`${resolved.in}:${resolved.name}`, parameter);
      }
      if (parameters.size) inherited.parameters = [...parameters.values()];
      operations.push({ label, id: anchor(`#/paths/${path.replace(/~/g, "~0").replace(/\//g, "~1")}/${method}`), operation: inherited });
    }
  }
  const renderedTargets = new Set(operations.map(({ id }) => id));
  const components = Object.entries(spec.components ?? {}).flatMap(([group, entries]) =>
    Object.entries(entries).map(([name, value]) => {
      const reference = `#/components/${group}/${name.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      renderedTargets.add(anchor(reference));
      return `<section id="${anchor(reference)}"><h3>${escapeHtml(group)} / ${escapeHtml(name)}</h3>${json(value)}</section>`;
    }),
  ).join("\n");
  // Fail the build on unsupported/broken references, including unused components.
  function validate(value) {
    if (value && typeof value === "object") {
      if (typeof value.$ref === "string") resolve(value.$ref);
      for (const child of Object.values(value)) validate(child);
    }
  }
  validate(spec);
  const extraTargets = [...references].filter((reference) => !renderedTargets.has(anchor(reference))).map((reference) =>
    `<section id="${anchor(reference)}"><h3>${escapeHtml(reference)}</h3>${json(resolve(reference))}</section>`,
  ).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(spec.info.title)} · API reference</title><link rel="stylesheet" href="/api/reference/reference.css"><script src="/api/reference/reference.js" defer></script></head>
<body><header><a class="skip" href="#content">Skip to reference</a><a href="/map">FieldLoop console</a><span>API reference</span></header>
<main id="content"><h1>${escapeHtml(spec.info.title)}</h1><p>Contract version <code>${escapeHtml(spec.info.version)}</code></p>
<p>Read the contract, follow schema references, or download the source.</p><p><a href="/api/reference/openapi.yaml">Download OpenAPI YAML</a> · <a href="/api/reference/openapi.json">Download OpenAPI JSON</a></p>
<p class="provenance">Source SHA-256: <code>${escapeHtml(sourceHash)}</code></p><p class="description">${escapeHtml(spec.info.description ?? "")}</p>
<h2>Servers and default security</h2>${json({ servers: spec.servers ?? [], security: spec.security ?? [] })}
<nav aria-label="Operations"><h2>Operations</h2><ul>${operations.map(({ label, id, operation }) => `<li><a href="#${id}"><code>${escapeHtml(label)}</code> — ${escapeHtml(operation.summary ?? operation.operationId ?? "")}</a></li>`).join("")}</ul></nav>
${operations.map(({ label, id, operation }) => `<article id="${id}"><h2>${escapeHtml(label)}</h2><p>${escapeHtml(operation.summary ?? "")}</p>${json(operation)}</article>`).join("\n")}
<h2>Shared components</h2>${components}<details><summary>Complete OpenAPI document</summary>${json(spec)}</details>
${extraTargets}</main></body></html>\n`;
}

export async function buildReference(root = new URL("../", import.meta.url)) {
  const source = await readFile(new URL("openapi.yaml", root), "utf8");
  const spec = parse(source);
  const html = renderReference(spec, createHash("sha256").update(source).digest("hex"));
  const design = parse((await readFile(new URL("../../DESIGN.md", root), "utf8")).split("---")[1]);
  const variables = Object.entries(design.colors).map(([name, value]) => `--color-${name}:${value};`);
  for (const [name, value] of Object.entries(design.spacing)) variables.push(`--space-${name}:${value};`);
  for (const [name, value] of Object.entries(design.typography)) {
    for (const [property, token] of Object.entries(value)) variables.push(`--type-${name}-${property}:${property === "fontFamily" ? JSON.stringify(token) : token};`);
  }
  const output = new URL("dist/reference/", root);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await writeFile(new URL("index.html", output), html);
  await writeFile(new URL("openapi.yaml", output), source);
  await writeFile(new URL("openapi.json", output), `${JSON.stringify(spec, null, 2)}\n`);
  await writeFile(new URL("reference.css", output), `:root{${variables.join("")}}\n${await readFile(new URL("scripts/reference.css", root), "utf8")}`);
  await cp(new URL("scripts/reference.js", root), new URL("reference.js", output));
  const require = createRequire(new URL("package.json", root));
  for (const [font, filename] of [["ibm-plex-mono", "ibm-plex-mono-latin-400-normal.woff2"], ["ibm-plex-sans-thai", "ibm-plex-sans-thai-thai-400-normal.woff2"]]) {
    await cp(require.resolve(`@fontsource/${font}/files/${filename}`), new URL(filename, output));
  }
  await writeFile(new URL("manifest.json", output), `${JSON.stringify({ sourceHash: createHash("sha256").update(source).digest("hex"), files: ["index.html", "openapi.yaml", "openapi.json", "reference.css", "reference.js", "ibm-plex-mono-latin-400-normal.woff2", "ibm-plex-sans-thai-thai-400-normal.woff2"] }, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildReference();
