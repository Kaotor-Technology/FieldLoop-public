import { readFileSync } from "node:fs";
import addFormats from "ajv-formats";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { isSignal } from "../src/signal.js";
import { isPubSubPush } from "../src/signal-worker.js";
import { isActionRequestCreate } from "../src/actions.js";

const spec = parse(readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8"));

describe("demo OpenAPI examples", () => {
  it("documents a synthetic Action Request accepted by the runtime contract", () => {
    const media = spec.paths["/v1/action-requests"].post.requestBody.content["application/json"];
    expect(media.examples?.syntheticWorkOrder).toBeDefined();
    const value = media.examples.syntheticWorkOrder.value;
    expect(isActionRequestCreate(value)).toBe(true);
    expect(value.simulated).toBe(true);
    expect(value.payload.title).toContain("Synthetic");
    expect(isActionRequestCreate({ ...value, requestedBy: "agent:spoofed" })).toBe(false);
    expect(isActionRequestCreate({ ...value, actionLevel: "l3" })).toBe(false);
  });
  it.each(["accept", "reject"])("documents a schema-valid synthetic Health Decision for %s", (decision) => {
    const media = spec.paths[`/v1/health-proposals/{healthProposalId}:${decision}`].post.requestBody.content["application/json"];
    expect(media.examples?.syntheticInspection).toBeDefined();
    const value = media.examples.syntheticInspection.value;
    const validate = new Ajv2020().compile(spec.components.schemas.HealthDecision);
    expect(validate(value)).toBe(true);
    expect(value.reason).toContain("Synthetic");
    expect(validate({ ...value, reason: "" })).toBe(false);
    expect(validate({ ...value, approvedBy: "agent:spoofed" })).toBe(false);
  });
  it.each(["/v1/bowties/{bowtieId}/risk", "/v1/bowties/{bowtieId}/risk/explain"])("documents the fail-closed calibration error for %s", (path) => {
    const response = spec.paths[path].get.responses["409"];
    expect(response.content?.["application/problem+json"]?.examples?.unconfiguredCalibration).toBeDefined();
    const value = response.content["application/problem+json"].examples.unconfiguredCalibration.value;
    const ajv = new Ajv2020();
    addFormats.default(ajv);
    ajv.addSchema(spec.components.schemas.ErrorCode, "#/components/schemas/ErrorCode");
    ajv.addSchema(spec.components.schemas.FieldError, "#/components/schemas/FieldError");
    const validate = ajv.compile(spec.components.schemas.Problem);
    expect(validate(value)).toBe(true);
    expect(value).toEqual({ type: "about:blank", status: 409, title: "Organisation Risk Matrix is not approved", code: "risk_matrix_unconfigured" });
    expect(validate({ ...value, status: 200 })).toBe(false);
    expect(validate({ ...value, code: "invented_approval" })).toBe(false);
  });
  it.each(["/v1/bowties/{bowtieId}/risk", "/v1/bowties/{bowtieId}/risk/explain"])("documents invalid calibration for %s", (path) => {
    const examples = spec.paths[path].get.responses["409"].content["application/problem+json"].examples;
    expect(examples.invalidCalibration).toBeDefined();
    const value = examples.invalidCalibration.value;
    const ajv = new Ajv2020();
    addFormats.default(ajv);
    ajv.addSchema(spec.components.schemas.ErrorCode, "#/components/schemas/ErrorCode");
    ajv.addSchema(spec.components.schemas.FieldError, "#/components/schemas/FieldError");
    const validate = ajv.compile(spec.components.schemas.Problem);
    expect(validate(value)).toBe(true);
    expect(value).toEqual({ type: "about:blank", status: 409, title: "Organisation risk calibration is invalid", code: "risk_matrix_invalid" });
    expect(value).not.toHaveProperty("riskScore");
    expect(validate({ ...value, code: "invented_calibration" })).toBe(false);
  });
  it.each(["/v1/bowties/{bowtieId}/risk", "/v1/bowties/{bowtieId}/risk/explain"])("documents invalid risk inputs for %s", (path) => {
    const examples = spec.paths[path].get.responses["409"].content["application/problem+json"].examples;
    expect(examples.invalidInputs).toBeDefined();
    const value = examples.invalidInputs.value;
    const ajv = new Ajv2020();
    addFormats.default(ajv);
    ajv.addSchema(spec.components.schemas.ErrorCode, "#/components/schemas/ErrorCode");
    ajv.addSchema(spec.components.schemas.FieldError, "#/components/schemas/FieldError");
    const validate = ajv.compile(spec.components.schemas.Problem);
    expect(validate(value)).toBe(true);
    expect(value).toEqual({ type: "about:blank", status: 409, title: "Risk inputs could not be validated", code: "risk_input_invalid" });
    expect(value).not.toHaveProperty("riskScore");
    expect(validate({ ...value, status: 200 })).toBe(false);
    expect(validate({ ...value, code: "invented_risk_input" })).toBe(false);
  });
});

// Denominator: all currently implemented operations in T47's six named demo API families.
const demoPaths = [
  ["/v1/assistant/sessions", "post"],
  ["/v1/assistant/sessions/{sessionId}/messages", "post"],
  ["/v1/assistant/sessions/{sessionId}:cancel", "post"],
  ["/v1/action-requests", "post"], ["/v1/action-requests/{actionRequestId}", "get"],
  ["/guardrail/v1/tool-calls:check", "post"],
  ["/guardrail/v1/chat/completions", "post"], ["/guardrail/v1/content:scan", "post"],
  ["/v1/bowties/{bowtieId}/risk", "get"], ["/v1/bowties/{bowtieId}/risk/explain", "get"],
  ["/v1/health-proposals", "get"],
  ["/v1/health-proposals/{healthProposalId}:accept", "post"],
  ["/v1/health-proposals/{healthProposalId}:reject", "post"],
] as const;

it.each(demoPaths)("provides descriptions, examples and errors for %s %s", (path, method) => {
  const operation = spec.paths[path][method];
  expect(operation.description.length).toBeGreaterThan(20);
  const media = [
    ...Object.values(operation.requestBody?.content ?? {}),
    ...Object.values(operation.responses).flatMap((r) => Object.values((r as { content?: Record<string, unknown> }).content ?? {})),
  ] as { example?: unknown; examples?: Record<string, unknown> }[];
  expect(media.some(m => m.example !== undefined || Object.keys(m.examples ?? {}).length > 0)).toBe(true);
  expect(Object.keys(operation.responses).some(code => /^[45]/.test(code))).toBe(true);
});

it("validates every inline demo example against its exact media schema", () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats.default(ajv);
  ajv.addSchema(spec, "urn:fieldloop:openapi");
  for (const [path, method] of demoPaths) {
    const operation = spec.paths[path][method];
    const candidates: [string[], Record<string, { schema: object; examples?: Record<string, { value: unknown }> }>][] = [];
    if (operation.requestBody?.content) candidates.push([["requestBody", "content"], operation.requestBody.content]);
    for (const [status, response] of Object.entries(operation.responses)) {
      const content = (response as { content?: Record<string, { schema: object; examples?: Record<string, { value: unknown }> }> }).content;
      if (content) candidates.push([["responses", status, "content"], content]);
    }
    for (const [tail, content] of candidates) for (const [media, contract] of Object.entries(content)) {
      const pointer = ["paths", path, method, ...tail, media, "schema"].map(s => s.replaceAll("~", "~0").replaceAll("/", "~1")).join("/");
      const validate = ajv.compile({ $ref: `urn:fieldloop:openapi#/${pointer}` });
      for (const { value } of Object.values(contract.examples ?? {})) {
        expect(validate(value), `${path}: ${JSON.stringify(validate.errors)}`).toBe(true);
        expect(validate(null)).toBe(false);
      }
    }
  }
});

it("documents a Pub/Sub push whose decoded body passes the runtime Signal validator", () => {
  const worker = JSON.parse(readFileSync(new URL("../signal-worker.v1.openapi.json", import.meta.url), "utf8"));
  const example = worker.paths["/internal/pubsub/signals"].post.requestBody.content["application/json"].examples.syntheticRectifierFailure.value;
  expect(isPubSubPush(example)).toBe(true);
  const signal = JSON.parse(Buffer.from(example.message.data, "base64").toString("utf8"));
  expect(isSignal(signal)).toBe(true);
  expect(signal.simulated).toBe(true);
  expect(example.message.attributes.signalId).toBe(signal.id);
  expect(isPubSubPush({ ...example, message: { ...example.message, attributes: {} } })).toBe(false);
  expect(isSignal({ ...signal, simulated: "true" })).toBe(false);
});
