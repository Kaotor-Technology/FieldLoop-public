/* global __ENV, __VU, __ITER */

import { check } from "k6";
import http from "k6/http";

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
    http_req_duration: ["p(95)<50"],
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

  check(response, {
    "content scan returns 200": (result) => result.status === 200,
    "content scan returns the supplied content": (result) => {
      try {
        return result.json("content") === content;
      } catch {
        return false;
      }
    },
  });
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
