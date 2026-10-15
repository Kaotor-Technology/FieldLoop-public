import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkTypeScriptBoundary, isRuntimeSource } from "./check-ai-boundary.mjs";

const service = "apps/assistant/src/caller.ts";

describe("GR-1 static model boundary gate", () => {
  it("fails CI for an untracked service bypass and passes after it uses Guardrail", () => {
    const root = mkdtempSync(join(tmpdir(), "fl37-ai-boundary-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      mkdirSync(join(root, "apps/api/src"), { recursive: true });
      const path = join(root, "apps/api/src/caller.ts");
      const gate = fileURLToPath(new URL("./check-ai-boundary.mjs", import.meta.url));
      writeFileSync(path, 'import { GoogleGenAI } from "@google/genai";');
      const denied = spawnSync(process.execPath, [gate], { cwd: root, encoding: "utf8" });
      expect(denied.status).toBe(1);
      expect(denied.stderr).toContain("apps/api/src/caller.ts:1");
      writeFileSync(path, 'fetch(`${guardrailUrl}/guardrail/v1/chat/completions`);');
      expect(spawnSync(process.execPath, [gate], { cwd: root }).status).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each([
    'import { GoogleGenAI } from "@google/genai";',
    'const sdk = require("@google-cloud/vertexai");',
    'const sdk = await import("@google-cloud/aiplatform");',
    'fetch(`https://${region}-aiplatform.googleapis.com/v1/projects/project/endpoints/openapi/chat/completions`);',
    'fetch("https://generativelanguage.googleapis.com/v1beta/models/model:generateContent");',
    'import { GoogleVertexChatCompletionsAdapter as Model } from "@fieldloop/adapters";',
    'const model = adapters["GoogleVertexChatCompletionsAdapter"];',
    'export { default } from "../../../packages/adapters/src/google-vertex-chat-completions.js";',
  ])("rejects a service bypass: %s", (source) => {
    expect(checkTypeScriptBoundary(service, source).length).toBeGreaterThan(0);
  });

  it("allows the provider adapter and Guardrail's adapter wiring", () => {
    expect(checkTypeScriptBoundary("packages/adapters/src/google-vertex-chat-completions.ts",
      'fetch(`https://${location}-aiplatform.googleapis.com/v1/chat/completions`);')).toEqual([]);
    expect(checkTypeScriptBoundary("apps/guardrail/src/server.ts",
      'import { GoogleVertexChatCompletionsAdapter } from "@fieldloop/adapters";')).toEqual([]);
  });

  it("still rejects a raw provider call from Guardrail or an unrelated adapter", () => {
    const source = 'import { GoogleGenAI } from "@google/genai";';
    expect(checkTypeScriptBoundary("apps/guardrail/src/server.ts", source)).toHaveLength(1);
    expect(checkTypeScriptBoundary("packages/adapters/src/blob-store.ts", source)).toHaveLength(1);
  });

  it("ignores comments and accepts a Guardrail HTTP client", () => {
    expect(checkTypeScriptBoundary(service,
      '// GoogleVertexChatCompletionsAdapter uses aiplatform.googleapis.com\nfetch(`${guardrailUrl}/guardrail/v1/chat/completions`);')).toEqual([]);
  });

  it("scans production sources and excludes dependencies, test fixtures and confidential paths", () => {
    expect(isRuntimeSource(service)).toBe(true);
    expect(isRuntimeSource("packages/adapters/python/src/fieldloop_adapters/embeddings.py")).toBe(true);
    for (const path of ["raw-data/src/secret.ts", "apps/assistant/test/fixture.ts", "apps/web/src/view.test.ts", "apps/web/node_modules/src/lib.ts"]) {
      expect(isRuntimeSource(path)).toBe(false);
    }
  });
});
