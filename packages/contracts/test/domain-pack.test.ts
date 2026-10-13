import { describe, expect, it } from "vitest";
import { parseDomainPack, parseAgentDefinition } from "../src/domain-pack.js";

describe("Domain Pack contracts", () => {
  it.each([null, [], {}, { simulated: false }, { version: 1 }])("rejects malformed pack content: %j", (value) => {
    expect(() => parseDomainPack(value, "pack.yaml")).toThrow("pack.yaml");
  });
  it.each([null, [], {}, { maxSteps: 0 }, { allowedTools: ["approve"] }])("rejects incomplete agent definitions: %j", (value) => {
    expect(() => parseAgentDefinition(value, "agents/example.yaml")).toThrow("agents/example.yaml");
  });
});
