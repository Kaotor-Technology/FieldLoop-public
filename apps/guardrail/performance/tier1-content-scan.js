/* global __ENV, __VU, __ITER */

import { check } from "k6";
import http from "k6/http";
import { Trend } from "k6/metrics";

// GR-8: the 50 ms budget is the latency Guardrail adds around the managed detector (Model Armor + SDP).
// The detector duration comes from the Server-Timing header and is reported, not targeted.
const guardrailAdded = new Trend("guardrail_added_latency", true);
const tier1Detector = new Trend("tier1_detector_latency", true);

const guardrailUrl = requiredEnv("GUARDRAIL_URL").replace(/\/$/, "");
const identityToken = requiredEnv("GUARDRAIL_ID_TOKEN");
const internalUserToken = requiredEnv("GUARDRAIL_INTERNAL_USER_TOKEN");
const aiSystem = requiredEnv("GUARDRAIL_AI_SYSTEM");
const vus = positiveIntegerEnv("K6_VUS", 1);
const iterations = positiveIntegerEnv("K6_ITERATIONS", 100);

export const options = {
  vus,
  iterations,
  thresholds: {
    guardrail_added_latency: ["p(95)<50"],
    http_req_failed: ["rate<0.01"],
    checks: ["rate>0.99"],
  },
};

export default function () {
  const content = "SYNTHETIC guardrail latency probe: routine document review completed.";
  const response = http.post(
    `${guardrailUrl}/guardrail/v1/content:scan`,
    JSON.stringify({ aiSystem, content }),
    {
      headers: {
        authorization: `Bearer ${identityToken}`,
        "x-fieldloop-internal-user-token": internalUserToken,
        "content-type": "application/json",
        "idempotency-key": `fieldloop-k6-${__VU}-${__ITER}-${Date.now()}-probe`,
        "x-fieldloop-classification": "INTERNAL",
      },
      tags: { name: "guardrail-tier1-content-scan" },
    },
  );

  // Print the first few problem+json bodies so a failed run says why; they carry no tokens.
  if (response.status !== 200 && __ITER < 3) {
    console.warn(`content:scan returned ${response.status}: ${String(response.body).slice(0, 500)}`);
  }

  const detectorMs = serverTimingDuration(response.headers["Server-Timing"], "detector");
  if (response.status === 200 && detectorMs !== null) {
    tier1Detector.add(detectorMs);
    guardrailAdded.add(Math.max(0, response.timings.duration - detectorMs));
  }

  check(response, {
    "content scan returns 200": (result) => result.status === 200,
    "content scan reports the detector duration": () => detectorMs !== null,
    "content scan returns the supplied content": (result) => {
      try {
        return result.json("content") === content;
      } catch {
        return false;
      }
    },
  });
}

function serverTimingDuration(header, stage) {
  if (typeof header !== "string") return null;
  const match = header.split(",").map((part) => part.trim()).find((part) => part.startsWith(`${stage};`));
  const duration = match ? Number(/dur=([0-9.]+)/.exec(match)?.[1]) : NaN;
  return Number.isFinite(duration) ? duration : null;
}

function requiredEnv(name) {
  const value = __ENV[name];
  if (!value || value.trim() !== value) throw new Error(`${name} must be configured`);
  return value;
}

function positiveIntegerEnv(name, fallback) {
  const value = Number(__ENV[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 100_000) {
    throw new Error(`${name} must be an integer from 1 to 100000`);
  }
  return value;
}
