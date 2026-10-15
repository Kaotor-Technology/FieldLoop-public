import { describe, expect, it } from "vitest";
import { parseRegisteredSignalRule, isPubSubPush, isWorkerEvent } from "../src/signal-worker.js";

const rule = {
  id: "00000000-0000-4000-8000-000000000158", pack: "pipeline-integrity", simulated: true, classification: "CONFIDENTIAL",
  condition: { kind: "signal", source: "mock-historian", tag: "DL-01.rectifier.output", operator: "eq", threshold: 0, unit: "A",
    ruleId: "cp-rectifier-output-lost", packVersion: "1.0.0", effect: { kind: "health_proposal", proposedHealth: "failed", reason: "SIMULATION periodic reading" } },
  targetBarrierSelector: { pack: "pipeline-integrity", bowtieCode: "dl-01-bowtie-a", barrierCodes: ["cathodic-protection"] },
};
describe("registered worker contracts", () => {
  it("accepts FL-78's persisted condition/effect shape without mutating it", () => {
    const before = structuredClone(rule); expect(parseRegisteredSignalRule(rule)).toEqual(before); expect(rule).toEqual(before);
  });
  it("accepts exact categorical pack thresholds while rejecting ordered string comparisons", () => {
    const categorical = { ...rule, pack: "flood-water", targetBarrierSelector: { ...rule.targetBarrierSelector, pack: "flood-water" },
      condition: { ...rule.condition, source: "mock-pumps", tag: "pump.power", operator: "eq", threshold: "lost", unit: "state",
        ruleId: "pump-power-lost", effect: { kind: "health_proposal", proposedHealth: "degraded", reason: "SIMULATION power loss" } } };
    expect(parseRegisteredSignalRule(categorical).condition.threshold).toBe("lost");
    expect(() => parseRegisteredSignalRule({ ...categorical, condition: { ...categorical.condition, operator: "gt" } })).toThrow();
    const booleanRule = { ...categorical, condition: { ...categorical.condition, threshold: false, unit: "state" } };
    expect(parseRegisteredSignalRule(booleanRule).condition.threshold).toBe(false);
  });
  it.each([
    { ...rule, targetBarrierSelector: { ...rule.targetBarrierSelector, pack: "other" } },
    { ...rule, condition: { ...rule.condition, kind: "evidence_ageing" } },
    { ...rule, condition: { ...rule.condition, durationSeconds: 0 } },
    { ...rule, condition: { ...rule.condition, effect: { kind: "apply_health", proposedHealth: "failed", reason: "bad" } } },
    { ...rule, simulated: undefined },
  ])("rejects unsafe or unsupported registered content", (value) => { expect(() => parseRegisteredSignalRule(value)).toThrow(); });
  it("requires push transport identity and explicit attributes", () => {
    expect(isPubSubPush({ message: { data: "e30=", messageId: "id", attributes: {} }, subscription: "signals" })).toBe(false);
  });
  it("accepts quarterly calendar measurements and rejects ambiguous intervals", () => {
    expect(parseRegisteredSignalRule({ ...rule, condition: { ...rule.condition, expectedIntervalMonths: 3 } }).condition.expectedIntervalMonths).toBe(3);
    expect(() => parseRegisteredSignalRule({ ...rule, condition: { ...rule.condition, expectedIntervalMonths: 3, expectedIntervalSeconds: 60 } })).toThrow();
  });
  it("validates at-least-once event identities and provenance", () => {
    const event = { id: rule.id, type: "health_proposal.created", orgId: "fixture", barrierId: rule.id, entityId: rule.id, simulated: true, classification: "CONFIDENTIAL" };
    expect(isWorkerEvent(event)).toBe(true); expect(isWorkerEvent({ ...event, simulated: undefined })).toBe(false);
    expect(isWorkerEvent({ ...event, type: "notification.delivered" })).toBe(true);
    expect(isWorkerEvent({ ...event, type: "barrier.health_changed" })).toBe(true);
    expect(isWorkerEvent({ ...event, type: "barrier.health_changed", health: "degraded" })).toBe(true);
    expect(isWorkerEvent({ ...event, type: "barrier.health_changed", health: "unknown" })).toBe(false);
    expect(isWorkerEvent({ ...event, type: "barrier.health.applied" })).toBe(false);
    const actionRequestEvent = { id: rule.id, type: "action_request.updated", orgId: "fixture", entityId: rule.id,
      status: "approved", simulated: true, classification: "CONFIDENTIAL" };
    expect(isWorkerEvent(actionRequestEvent)).toBe(true);
    expect(isWorkerEvent({ ...actionRequestEvent, status: undefined })).toBe(false);
  });
});
