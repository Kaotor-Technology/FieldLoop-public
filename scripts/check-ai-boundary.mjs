import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const PROVIDER_SDK = /^(?:@google\/genai|@google-cloud\/(?:vertexai|aiplatform))(?:\/|$)/;
const GENERATIVE_ADAPTER = /google-vertex-chat-completions/;
const PROVIDER_ENDPOINT = /(?:aiplatform\.googleapis\.com|generativelanguage\.googleapis\.com|api\.(?:openai|anthropic)\.com)/;

export function isRuntimeSource(path) {
  return /^(?:apps|packages|py)\/.+\/src\/.+\.(?:[cm]?[jt]sx?|py)$/.test(path)
    && !/(?:^|\/)(?:node_modules|dist|test|tests|__tests__|fixtures)(?:\/|$)/.test(path)
    && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);
}

/** Static architecture gate; deployment IAM/egress remains a separate enforcement layer. */
export function checkTypeScriptBoundary(path, source) {
  if (!isRuntimeSource(path) || path.endsWith(".py")) return [];
  const providerAdapter = path === "packages/adapters/src/google-vertex-chat-completions.ts";
  const guardrail = path.startsWith("apps/guardrail/src/");
  const adapterIndex = path === "packages/adapters/src/index.ts";
  const errors = new Set();
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const report = (node, reason) => {
    const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
    errors.add(`${path}:${line}: ${reason}`);
  };
  const visit = (node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      const value = ts.isTemplateExpression(node) ? node.getText(tree) : node.text;
      if (!providerAdapter && PROVIDER_SDK.test(value)) report(node, "Provider SDK belongs in the Guardrail's adapter");
      if (!providerAdapter && PROVIDER_ENDPOINT.test(value)) report(node, "Direct model endpoint bypasses Guardrail (GR-1)");
      if (!providerAdapter && !guardrail && !adapterIndex && GENERATIVE_ADAPTER.test(value)) {
        report(node, "Only Guardrail may import the generative model adapter (GR-1)");
      }
    }
    if (!guardrail && !providerAdapter && !adapterIndex &&
      ((ts.isIdentifier(node) && node.text === "GoogleVertexChatCompletionsAdapter") ||
        (ts.isStringLiteralLike(node) && node.text === "GoogleVertexChatCompletionsAdapter"))) {
      report(node, "Only Guardrail may use the generative model adapter (GR-1)");
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return [...errors];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Paths first: never read confidential material, fixtures, generated output or dependencies.
  const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" });
  const errors = [...new Set(paths.split("\0"))].filter(isRuntimeSource)
    .filter((path) => !path.endsWith(".py") && !/(?:^|\/)raw-data(?:\/|$)/i.test(path))
    .flatMap((path) => checkTypeScriptBoundary(path, readFileSync(path, "utf8")));
  if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
  else console.log("TypeScript model calls respect the Guardrail boundary (GR-1).");
}
