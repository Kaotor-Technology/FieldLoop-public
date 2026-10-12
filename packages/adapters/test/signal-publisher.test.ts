import { readFileSync } from "node:fs";
import { isSignal } from "@fieldloop/contracts";
import { describe, expect, it, vi } from "vitest";
import { SignalPublisher } from "../src/signal-publisher.js";

const cases: { name: string; valid: boolean; signal: unknown }[] = JSON.parse(
  readFileSync(new URL("../../contracts/test/fixtures/signal-cases.json", import.meta.url), "utf8"),
);
const config = { environment: "dev", orgId: "fieldloop-demo", simulationOnly: false } as const;
const baseSignal = cases[0]?.signal;
if (!isSignal(baseSignal)) throw new Error("Missing synthetic Signal fixture");

describe("validating publisher (FL-149)", () => {
  it.each(cases)("routes $name", async ({ signal, valid }) => {
    const publish = vi.fn().mockResolvedValue("message-73");
    const publisher = new SignalPublisher({ publish }, config);
    expect(await publisher.publish(signal)).toEqual({
      outcome: valid ? "published" : "dead_lettered", messageId: "message-73",
    });
    expect(publish).toHaveBeenCalledTimes(1);
    const [topic, bytes, attributes] = publish.mock.calls[0] ?? [];
    expect(topic).toBe(valid ? "signals" : "fieldloop-v2-dead-letter");
    expect(JSON.parse(Buffer.from(bytes).toString("utf8"))).toEqual(signal);
    expect(attributes).toMatchObject({ environment: "dev", orgId: "fieldloop-demo", schemaVersion: "signal.v1" });
    if (!valid) expect(attributes).toMatchObject({ failureReason: "validation_failed", classification: "HIGHLY_RESTRICTED" });
  });

  it("quarantines a mock message labelled real and a foreign Organisation", async () => {
    const publish = vi.fn().mockResolvedValue("dead-1");
    const publisher = new SignalPublisher({ publish }, { ...config, simulationOnly: true });
    await publisher.publish({ ...baseSignal, simulated: false });
    expect(publish.mock.calls[0]?.[2]).toMatchObject({ failureReason: "simulation_required" });
    await publisher.publish({ ...baseSignal, orgId: "other-org" });
    expect(publish.mock.calls[1]?.[2]).toMatchObject({ failureReason: "org_mismatch", orgId: "fieldloop-demo" });
  });

  it("propagates failures on either topic without claiming success or trying the other", async () => {
    for (const signal of [cases[0]?.signal, {}]) {
      const publish = vi.fn().mockRejectedValue(new Error("unavailable"));
      await expect(new SignalPublisher({ publish }, config).publish(signal)).rejects.toThrow("unavailable");
      expect(publish).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps producer identity, provenance and bytes unchanged on retries", async () => {
    const publish = vi.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    const publisher = new SignalPublisher({ publish }, config);
    const signal = cases[0]?.signal;
    const before = JSON.stringify(signal);
    await publisher.publish(signal);
    await publisher.publish(signal);
    expect(publish.mock.calls[0]).toEqual(publish.mock.calls[1]);
    expect(JSON.stringify(signal)).toBe(before);
  });

  it.each([NaN, Infinity, undefined, 1n, new Date(), { value: undefined }, [undefined]])(
    "rejects non-JSON input before transport", async (signal) => {
      const publish = vi.fn();
      await expect(new SignalPublisher({ publish }, config).publish(signal)).rejects.toThrow();
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it("rejects cyclic, accessor and oversized values", async () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const publish = vi.fn();
    const publisher = new SignalPublisher({ publish }, config);
    for (const value of [cycle, { get value() { throw new Error("getter should not run"); } }, "x".repeat(256 * 1024)]) {
      await expect(publisher.publish(value)).rejects.toThrow();
    }
    expect(publish).not.toHaveBeenCalled();
  });

  it("rejects configuration that cannot isolate delivery or dead-letter routing", () => {
    const transport = { publish: vi.fn() };
    expect(() => new SignalPublisher(transport, { ...config, orgId: "" })).toThrow();
    expect(() => new SignalPublisher(transport, { ...config, signalTopic: "signals", deadLetterTopic: "signals" })).toThrow();
  });

  it.each([
    { signalTopic: "signals", deadLetterTopic: "projects/test-project/topics/signals" },
    { signalTopic: "projects/test-project/topics/signals", deadLetterTopic: "signals" },
    { signalTopic: "projects/test-project/topics/signals", deadLetterTopic: "projects/test-project/topics/dead-letter" },
    { signalTopic: "signals ", deadLetterTopic: "dead-letter" },
    { signalTopic: "signals", deadLetterTopic: " dead-letter" },
  ])("rejects topic aliases and non-canonical names before transport: %j", (topics) => {
    const publish = vi.fn();
    expect(() => new SignalPublisher({ publish }, { ...config, ...topics })).toThrow();
    expect(publish).not.toHaveBeenCalled();
  });
});
