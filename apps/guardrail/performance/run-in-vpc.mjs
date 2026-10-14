// Entrypoint for the one-off in-VPC latency job. It obtains the two credentials the k6 probe
// needs from the job's own service identity, then runs the probe. Nothing is read from or
// written to disk, and neither token is printed or passed on the command line.
import { spawn } from "node:child_process";
import { GoogleCloudSecretReader } from "@fieldloop/adapters";
import { SecretManagerInternalTokenService } from "./dist/auth/internal-tokens.js";

const METADATA_IDENTITY_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";
const SYNTHETIC_SUBJECT = "synthetic-guardrail-latency-probe";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be configured`);
  return value;
}

async function identityToken(audience) {
  const url = `${METADATA_IDENTITY_URL}?audience=${encodeURIComponent(audience)}`;
  const response = await fetch(url, { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Metadata identity token request failed with HTTP ${response.status}`);
  return (await response.text()).trim();
}

async function main() {
  const guardrailUrl = requiredEnv("GUARDRAIL_URL").replace(/\/$/, "");
  const baseUrl = requiredEnv("FIELDLOOP_BASE_URL");
  const orgId = requiredEnv("FIELDLOOP_DEFAULT_ORG_ID");
  const projectId = requiredEnv("GOOGLE_CLOUD_PROJECT");
  requiredEnv("GUARDRAIL_AI_SYSTEM");

  // The same signer web-api uses, so the claims match what the Guardrail verifier expects.
  const signer = new SecretManagerInternalTokenService(
    new GoogleCloudSecretReader(projectId),
    new URL(baseUrl).origin,
    "fieldloop-services",
    process.env["FIELDLOOP_INTERNAL_SIGNING_KID"]?.trim() || "current",
  );
  const internalUserToken = await signer.sign({
    sub: SYNTHETIC_SUBJECT,
    orgId,
    roles: ["fieldloop.operator"],
    clearance: "INTERNAL",
  });
  const k6 = spawn("k6", ["run", "/scripts/tier1-content-scan.js"], {
    stdio: "inherit",
    env: {
      ...process.env,
      GUARDRAIL_URL: guardrailUrl,
      GUARDRAIL_ID_TOKEN: await identityToken(guardrailUrl),
      GUARDRAIL_INTERNAL_USER_TOKEN: internalUserToken,
    },
  });
  const code = await new Promise((resolve, reject) => {
    k6.on("error", reject);
    k6.on("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
  });
  process.exitCode = code;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Latency probe failed");
  process.exitCode = 1;
});
