import { describe, expect, it } from "vitest";
import { matchesRule, streamKey, maximumClassification } from "../src/rule-evaluator.js";
import { rule, signal } from "./fixtures.js";

describe("periodic measurement rules", () => {
  it("evaluates a periodic CP reading without pretending it is continuous", () => {
    expect(matchesRule(rule, signal, [], 86400)).toBe(true);
    expect(matchesRule(rule, { ...signal, value: 2 }, [], 86400)).toBe(false);
  });
  it.each([null, "0", true])("does not coerce an unavailable/wrong-unit value %s", (value) => {
    expect(matchesRule(rule, { ...signal, value }, [], 86400)).toBe(false);
  });
  it("maps boolean statuses only for boolean units", () => {
    const status = { ...rule, condition: { ...rule.condition, unit: "boolean" } };
    expect(matchesRule(status, { ...signal, unit: "boolean", value: false }, [], 60)).toBe(true);
  });
  it("matches categorical states by exact string equality and exact unit", () => {
    const status = { ...rule, condition: { ...rule.condition, threshold: "lost" as const, unit: "state" } };
    expect(matchesRule(status, { ...signal, unit: "state", value: "lost" }, [], 60)).toBe(true);
    expect(matchesRule(status, { ...signal, unit: "state", value: "available" }, [], 60)).toBe(false);
    const missingUnit = { ...signal };
    delete missingUnit.unit;
    expect(matchesRule(status, { ...missingUnit, value: "lost" }, [], 60)).toBe(false);
    expect(matchesRule(status, { ...signal, unit: "state", value: 1 }, [], 60)).toBe(false);
  });
  it("keeps threshold and unit/provenance boundaries exact", () => {
    const threshold = { ...rule, condition: { ...rule.condition, operator: "gt" as const, threshold: 100, windowSeconds: 86400 } };
    expect(matchesRule(threshold, { ...signal, value: 100 }, [], 60)).toBe(false);
    expect(matchesRule(threshold, { ...signal, value: 101 }, [], 60)).toBe(true);
    expect(matchesRule(rule, { ...signal, unit: "mA" }, [], 60)).toBe(false);
    expect(matchesRule(rule, { ...signal, simulated: false }, [], 60)).toBe(false);
  });
  it("requires strictly more than duration with no missing measurements", () => {
    const continuousRule = { ...rule, condition: { ...rule.condition, source: "mock-continuous", tag: "telemetry.continuous", expectedIntervalSeconds: 60, durationSeconds: 120 } };
    const continuousSignal = { ...signal, source: "mock-continuous", tag: "telemetry.continuous" };
    const at = (seconds: number, value = 0) => ({ ...continuousSignal, value, observedAt: new Date(Date.parse(signal.observedAt) + seconds * 1000).toISOString() });
    expect(matchesRule(continuousRule, at(120), [at(0), at(60), at(120)], 60)).toBe(false);
    expect(matchesRule(continuousRule, at(121), [at(0), at(60), at(120), at(121)], 60)).toBe(true);
    expect(matchesRule(continuousRule, at(180), [at(0), at(180)], 60)).toBe(false);
    expect(matchesRule(continuousRule, at(180), [at(0), at(60, 1), at(120), at(180)], 60)).toBe(false);
    expect(matchesRule(continuousRule, at(180), [at(0), at(60), at(120), at(180)].map((item) => ({ ...item, simulationRunId: "other" })), 60)).toBe(false);
  });
  it("separates runs, assets and simulation provenance and never downgrades classification", () => {
    expect(streamKey(signal)).not.toEqual(streamKey({ ...signal, simulationRunId: "new-run" }));
    expect(streamKey(signal)).not.toEqual(streamKey({ ...signal, assetId: "other" }));
    expect(maximumClassification("PUBLIC", "HIGHLY_RESTRICTED", "CONFIDENTIAL")).toBe("HIGHLY_RESTRICTED");
  });
});
