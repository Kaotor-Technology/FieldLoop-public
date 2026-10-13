import { isSignal, type PubSubPush, type RegisteredSignalRule, type Signal } from "@fieldloop/contracts";
import { readFileSync } from "node:fs";
import type { WorkerRuntime } from "../src/model.js";
import { vi } from "vitest";

export const signal: Signal = {
  schemaVersion: "signal.v1", id: "00000000-0000-4000-8000-000000000076", orgId: "worker-fixture",
  source: "mock-historian", tag: "DL-01.rectifier.output", value: 0, unit: "A",
  observedAt: "2026-10-13T00:00:00Z", simulated: true, classification: "CONFIDENTIAL",
};
// Source-contract samples pinned to PR #47 snapshot c141dde794885e8e3c2ce0fbd553d200e37b651a.
// This shared fixture stays independent of signal-cases.json.
const sourceSamples: unknown = JSON.parse(readFileSync(new URL("./fixtures/pr47-signals.json", import.meta.url), "utf8"));
function sourceSignal(name: string): Signal {
  const candidate = typeof sourceSamples === "object" && sourceSamples !== null
    ? Reflect.get(sourceSamples, name)
    : undefined;
  if (!isSignal(candidate)) throw new Error(`Invalid PR #47 Signal fixture: ${name}`);
  return candidate;
}
export const pr47RainRateSignal = sourceSignal("rainRate");
export const pr47RainAccumulationSignal = sourceSignal("rainAccumulation");
export const pr47PumpSignal = sourceSignal("pump");
export const rule: RegisteredSignalRule = {
  id: "00000000-0000-4000-8000-000000000158", pack: "pipeline-integrity", simulated: true, classification: "CONFIDENTIAL",
  condition: { kind: "signal", source: signal.source, tag: signal.tag, operator: "eq", threshold: 0, unit: "A",
    ruleId: "cp-rectifier-output-lost", packVersion: "1.0.0", effect: { kind: "health_proposal", proposedHealth: "failed", reason: "SIMULATION inspection reading is zero; human review required" } },
  targetBarrierSelector: { pack: "pipeline-integrity", bowtieCode: "dl-01-bowtie-a", barrierCodes: ["cathodic-protection"] },
};
export function runtime(): WorkerRuntime {
  return {
    store: { ingest: vi.fn().mockResolvedValue(undefined), detectSilence: vi.fn().mockResolvedValue(1), publishPending: vi.fn().mockResolvedValue(undefined) },
    identity: { verify: vi.fn().mockResolvedValue(undefined) },
    audience: "https://worker.example.test", pushEmail: "push@example.test", schedulerEmail: "scheduler@example.test",
    subscription: "projects/fixture/subscriptions/signals-local", orgId: signal.orgId,
    environment: "local", simulatedOnly: true, publish: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined),
  };
}
export function push(value: Signal = signal): PubSubPush {
  return {
    subscription: "projects/fixture/subscriptions/signals-local",
    message: { data: Buffer.from(JSON.stringify(value)).toString("base64"), messageId: "pubsub-fixture-76",
      attributes: { environment: "local", orgId: value.orgId, schemaVersion: value.schemaVersion, signalId: value.id,
        simulated: String(value.simulated), classification: value.classification } },
  };
}
