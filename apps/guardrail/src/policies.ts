import { fileURLToPath } from "node:url";
import { DEMO_AGENT_TOOL_NAMES, loadDomainPacks } from "@fieldloop/adapters";

/** Configuration only: the gateway/detectors and Intercept persistence are FL-86. */
export async function loadGuardrailPolicies(root: URL | string = process.env["FIELDLOOP_DOMAIN_PACKS_DIR"]
    ?? fileURLToPath(new URL("../../../domain-packs/", import.meta.url))) {
  const packs = await loadDomainPacks(root, DEMO_AGENT_TOOL_NAMES, ["pipeline-integrity", "gen-ai-safety"]);
  const safety = packs.find(({ content }) => content.id === "gen-ai-safety")?.aiSafety;
  if (!safety) throw new Error("gen-ai-safety/ai-safety.yaml: required AI Safety configuration missing");
  return safety;
}
