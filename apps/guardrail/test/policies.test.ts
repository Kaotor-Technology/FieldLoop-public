import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadGuardrailPolicies } from "../src/policies.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("Guardrail startup policy catalog (FL-85 / FL-36)", () => {
  it("loads four enforce/fail-closed policies for the single UC-1 AI System", async () => {
    const safety = await loadGuardrailPolicies();
    expect(safety.aiSystem.id).toBe("demo-uc-1");
    expect(safety.policies).toHaveLength(4);
    expect(safety.policies.every(({ mode, failMode }) => mode === "enforce" && failMode === "fail-closed")).toBe(true);
  });

  it("rejects unknown detectors before service startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fl85-detector-"));
    directories.push(directory);
    await cp(new URL("../../../domain-packs/", import.meta.url), directory, { recursive: true });
    const file = join(directory, "gen-ai-safety", "ai-safety.yaml");
    await writeFile(file, (await readFile(file, "utf8")).replace("detector: model-armor", "detector: absent-detector"));
    await expect(loadGuardrailPolicies(directory)).rejects.toThrow(/ai-safety.yaml.*detector/);
  });

  it("fails closed when the required catalog is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fl85-missing-"));
    directories.push(directory);
    await expect(loadGuardrailPolicies(directory)).rejects.toThrow(/no Domain Packs|required pack missing/);
  });
});
