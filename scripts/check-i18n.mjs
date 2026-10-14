import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export function flattenResources(resource, prefix = "", result = {}) {
  for (const [key, value] of Object.entries(resource)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) flattenResources(value, path, result);
    else result[path] = value;
  }
  return result;
}

function placeholders(value) {
  return [...value.matchAll(/{{\s*([^{}]+?)\s*}}/g)].map((match) => match[1]).sort().join(",");
}

export function validateResources(resources, usedKeys = []) {
  const flattened = Object.fromEntries(Object.entries(resources).map(([language, resource]) => [language, flattenResources(resource)]));
  const keys = new Set([...Object.values(flattened).flatMap(Object.keys), ...usedKeys]);
  const errors = [];
  for (const key of [...keys].sort()) {
    for (const [language, resource] of Object.entries(flattened)) {
      if (!(key in resource)) errors.push(`${language}: missing key ${key}`);
      else if (typeof resource[key] !== "string" || !resource[key].trim()) errors.push(`${language}: empty or invalid value for ${key}`);
      else if (typeof flattened.en?.[key] === "string" && placeholders(resource[key]) !== placeholders(flattened.en[key])) errors.push(`${language}: interpolation mismatch for ${key}`);
    }
  }
  return errors;
}

export function translationKeys(source, filename = "component.tsx") {
  const keys = [];
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t") {
      const collect = (argument) => {
        if (!argument) return;
        if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) keys.push(argument.text);
        else if (ts.isConditionalExpression(argument)) { collect(argument.whenTrue); collect(argument.whenFalse); }
      };
      collect(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return keys;
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(path) && !/\.test\.ts$/.test(path) ? [path] : [];
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const resources = Object.fromEntries(["en", "th"].map((language) => [language, JSON.parse(readFileSync(join(root, `apps/web/src/locales/${language}.json`), "utf8"))]));
  const keys = sourceFiles(join(root, "apps/web/src")).flatMap((path) => translationKeys(readFileSync(path, "utf8"), path));
  const errors = validateResources(resources, keys);
  if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
  else console.log(`English and Thai resources match: ${Object.keys(flattenResources(resources.en)).length} keys; ${new Set(keys).size} literal UI keys checked.`);
}
