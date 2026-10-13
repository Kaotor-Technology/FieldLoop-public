import { createHash } from "node:crypto";
import type { RegisteredSignalRule, Signal, WorkerEvent } from "@fieldloop/contracts";

export function streamKey(signal: Signal): string {
  return createHash("sha256").update(JSON.stringify([
    signal.source, signal.tag, signal.assetId?.toLowerCase() ?? null, signal.barrierId?.toLowerCase() ?? null,
    signal.simulationRunId?.toLowerCase() ?? null, signal.unit ?? null, signal.simulated,
  ])).digest("hex");
}
export function maximumClassification(...values: WorkerEvent["classification"][]): WorkerEvent["classification"] {
  const levels = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED"] as const;
  return levels[Math.max(...values.map((value) => levels.indexOf(value)))] ?? "HIGHLY_RESTRICTED";
}
export function matchesReading(rule: RegisteredSignalRule, signal: Signal): boolean {
  const { condition } = rule;
  if (signal.source !== condition.source || signal.tag !== condition.tag || signal.unit !== condition.unit
      || signal.simulated !== rule.simulated) return false;
  const value = typeof signal.value === "boolean" && condition.unit === "boolean"
    ? Number(signal.value) : signal.value;
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  switch (condition.operator) {
    case "gt": return value > condition.threshold;
    case "lt": return value < condition.threshold;
    case "eq": return value === condition.threshold;
  }
}

/** A duration requires sampled continuity with no missing expected observations.
 * windowSeconds describes an already aggregated source measurement (e.g. rain/24h);
 * it never invents continuous CP measurements between periodic inspections. */
export function matchesRule(rule: RegisteredSignalRule, signal: Signal, history: readonly Signal[], expectedIntervalSeconds: number): boolean {
  if (!matchesReading(rule, signal)) return false;
  const duration = rule.condition.durationSeconds;
  if (!duration) return true;
  const end = Date.parse(signal.observedAt);
  const ordered = history.filter((item) => streamKey(item) === streamKey(signal) && Date.parse(item.observedAt) <= end)
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
  let start = end;
  let previous = end;
  for (const item of ordered.reverse()) {
    const at = Date.parse(item.observedAt);
    if (!matchesReading(rule, item) || previous - at > expectedIntervalSeconds * 1000) break;
    start = at;
    previous = at;
  }
  return end - start > duration * 1000;
}
