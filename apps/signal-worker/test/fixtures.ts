import type { PubSubPush, RegisteredSignalRule, Signal } from "@fieldloop/contracts";
import type { WorkerRuntime } from "../src/model.js";
import { vi } from "vitest";

export const signal: Signal = {
  schemaVersion: "signal.v1", id: "00000000-0000-4000-8000-000000000076", orgId: "worker-fixture",
  source: "mock-historian", tag: "DL-01.rectifier.output", value: 0, unit: "A",
  observedAt: "2026-10-13T00:00:00Z", simulated: true, classification: "CONFIDENTIAL",
};
// Published source shape pinned to PR #47 head 4edbd3b88f94764c59462c0ddbf6de4a80f1c3a4.
// Keep these worker-boundary samples independent of signal-cases.json.
export const pr47RainRateSignal: Signal = {
  schemaVersion: "signal.v1", id: "00000000-0000-4000-8000-000000000147", orgId: "worker-fixture",
  source: "mock-hydro", tag: "rain.rate", value: 60, unit: "mm/h",
  observedAt: "2026-10-12T06:00:00Z", simulated: true, classification: "CONFIDENTIAL",
  simulationRunId: "00000000-0000-4000-8000-000000000149",
  payload: { assetCode: "S-R1", zone: "Z3", kind: "rain", label: "SIMULATION" },
};
export const pr47RainAccumulationSignal: Signal = {
  schemaVersion: "signal.v1", id: "00000000-0000-4000-8000-000000000150", orgId: "worker-fixture",
  source: "mock-hydro", tag: "rain.accumulation.24h", value: 101, unit: "mm",
  observedAt: "2026-10-12T06:01:00Z", simulated: true, classification: "CONFIDENTIAL",
  simulationRunId: "00000000-0000-4000-8000-000000000149",
  payload: { assetCode: "S-R1", zone: "Z3", kind: "rain", windowSeconds: 86400, label: "SIMULATION" },
};
export const pr47PumpSignal: Signal = {
  schemaVersion: "signal.v1", id: "00000000-0000-4000-8000-000000000148", orgId: "worker-fixture",
  source: "mock-pumps", tag: "pump.power", value: "lost", unit: "state",
  observedAt: "2026-10-12T06:20:00Z", simulated: true, classification: "CONFIDENTIAL",
  simulationRunId: "00000000-0000-4000-8000-000000000149",
  payload: { assetCode: "P-3", facilityType: "pump", zone: "Z3", operatingState: "stopped", label: "SIMULATION" },
};
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
