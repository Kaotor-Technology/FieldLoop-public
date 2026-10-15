import { existsSync, readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";

const file = new URL("../assistant.v1.openapi.json", import.meta.url);
const spec = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { paths: {} };

describe("assistant session creation service contract", () => {
  it("documents the actual internal route and strict session request/response", () => {
    const operation = spec.paths["/assistant/v1/sessions"]?.post;
    expect(operation).toBeDefined();
    expect(operation.security).toEqual([{ internalUserToken: [] }]);
    const ajv = new Ajv({ strict: false });
    const request = ajv.compile(operation.requestBody.content["application/json"].schema);
    expect(request({ agent: "flood-situation" })).toBe(true);
    expect(request({ agent: "" })).toBe(false);
    expect(request({ agent: "a".repeat(65) })).toBe(false);
    expect(request({ agent: "flood-situation", org_id: "other" })).toBe(false);
    const response = ajv.compile(operation.responses["201"].content["application/json"].schema);
    expect(response({ id: "synthetic-session", agent: "flood-situation", simulated: true,
      classification: "INTERNAL", status: "active" })).toBe(true);
    expect(response({ id: "synthetic-session" })).toBe(false);
    expect(operation.responses["422"].content["application/json"].schema.required).toContain("detail");
    expect(Object.keys(operation.responses)).toEqual(expect.arrayContaining(["201", "400", "401", "422", "503"]));
  });
});


describe("assistant cancellation service contract", () => {
  it("documents asynchronous cancellation without claiming completion", () => {
    const operation = spec.paths["/assistant/v1/sessions/{session_id}:cancel"]?.post;
    expect(operation).toBeDefined();
    expect(operation.security).toEqual([{ internalUserToken: [] }]);
    expect(operation.requestBody).toBeUndefined();
    expect(operation.parameters).toContainEqual({ name: "session_id", in: "path", required: true, schema: { type: "string" } });
    const content = operation.responses["202"].content["application/json"];
    const validate = new Ajv({ strict: false }).compile(content.schema);
    expect(validate({ cancelling: true })).toBe(true);
    expect(validate({ cancelling: false })).toBe(true);
    expect(validate({})).toBe(false);
    expect(validate({ cancelling: "true" })).toBe(false);
    expect(validate(content.example)).toBe(true);
    for (const [status, code] of [["401", "unauthenticated"], ["404", "not_found"], ["503", "service_unavailable"]] as const) {
      const error = operation.responses[status].content["application/problem+json"];
      expect(error.example).toEqual({ type: "about:blank", title: code, status: Number(status), code });
      expect(new Ajv({ strict: false }).compile(error.schema)(error.example)).toBe(true);
    }
    expect(operation.responses["422"].content["application/json"].schema.required).toContain("detail");
  });
});


describe("assistant message streaming service contract", () => {
  it("documents bounded messages, SSE transport and pre-stream errors", () => {
    const operation = spec.paths["/assistant/v1/sessions/{session_id}/messages"]?.post;
    expect(operation).toBeDefined();
    expect(operation.security).toEqual([{ internalUserToken: [] }]);
    expect(operation.parameters).toContainEqual({ name: "session_id", in: "path", required: true, schema: { type: "string" } });
    const content = operation.requestBody.content["application/json"];
    const validate = new Ajv({ strict: false }).compile(content.schema);
    expect(validate(content.example)).toBe(true);
    expect(validate({ message: "a".repeat(4000) })).toBe(true);
    for (const body of [{ message: "" }, { message: "a".repeat(4001) }, {}, { message: "hello", org_id: "other" }]) {
      expect(validate(body)).toBe(false);
    }
    const response = operation.responses["200"];
    expect(Object.keys(response.content)).toEqual(["text/event-stream"]);
    expect(response.content["text/event-stream"].schema).toEqual({ type: "string" });
    expect(response.headers["Cache-Control"].schema.const).toBe("private, no-store");
    expect(response.headers["X-Accel-Buffering"].schema.const).toBe("no");
    for (const [status, code] of [["401", "unauthenticated"], ["403", "forbidden"], ["404", "not_found"], ["409", "turn_in_progress"], ["503", "service_unavailable"]] as const) {
      const error = operation.responses[status].content["application/problem+json"];
      expect(error.example).toEqual({ type: "about:blank", title: code, status: Number(status), code });
      expect(new Ajv({ strict: false }).compile(error.schema)(error.example)).toBe(true);
    }
    expect(operation.responses["422"].content["application/json"].schema.required).toContain("detail");
  });

  it("documents a nullable Guardrail Policy ID on decision events", () => {
    const events = spec.paths["/assistant/v1/sessions/{session_id}/messages"]?.post["x-fieldloop-sse-events"];
    const decisionSchema = events["guardrail.decision"];
    const validate = new Ajv({ strict: false }).compile(decisionSchema);
    const base = { agent: "integrity-orchestrator", tool: "get_barriers", decision: "allow", source: "guardrail" };

    expect(decisionSchema.properties.policy_id).toMatchObject({
      type: ["string", "null"],
      description: expect.stringContaining("null means the source did not provide an ID"),
    });
    expect(decisionSchema.required).toContain("policy_id");
    expect(validate({ ...base, policy_id: "22222222-2222-4333-8444-555555555555" })).toBe(true);
    expect(validate({ ...base, source: "model", policy_id: "routing-policy" })).toBe(true);
    expect(validate({ ...base, policy_id: null })).toBe(true);
    expect(validate(base)).toBe(false);
    expect(validate({ ...base, policy_id: 123 })).toBe(false);
  });
});
