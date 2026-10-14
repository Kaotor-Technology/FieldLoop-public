import { describe, expect, it } from "vitest";
import { createWorkerRuntime } from "../src/runtime.js";

describe("worker configuration", () => {
  it("provides only scaffold health when no DB is configured", async () => {
    expect(await createWorkerRuntime({})).toBeUndefined();
  });
  it("stops before DB access on incomplete configured deployments", async () => {
    await expect(createWorkerRuntime({ DATABASE_URL: "postgres://invalid.invalid/db" })).rejects.toThrow("FIELDLOOP_DEFAULT_ORG_ID");
  });
  it("requires explicit periodic measurement intervals", async () => {
    await expect(createWorkerRuntime({ DATABASE_URL: "postgres://invalid.invalid/db", FIELDLOOP_DEFAULT_ORG_ID: "fixture", FIELDLOOP_ENV: "demo",
      FIELDLOOP_WORKER_AUDIENCE: "https://worker.example.test", FIELDLOOP_PUBSUB_PUSH_EMAIL: "push@example.test", FIELDLOOP_SCHEDULER_EMAIL: "scheduler@example.test",
      FIELDLOOP_SIGNAL_SUBSCRIPTION: "projects/fixture/subscriptions/signals", GOOGLE_CLOUD_PROJECT: "fixture", FIELDLOOP_SOURCE_INTERVALS: '{"mock-historian":0}', SIMULATED: "true",
    })).rejects.toThrow("positive periodic measurement");
  });
});
