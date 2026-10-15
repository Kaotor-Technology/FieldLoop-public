import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { WorkerError } from "../src/model.js";
import { pr47PumpSignal, pr47RainAccumulationSignal, pr47RainRateSignal, push, runtime, signal } from "./fixtures.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
function fixture() { const config = runtime(); const app = buildApp(config); apps.push(app); return { app, config }; }
const headers = { authorization: "Bearer test-service-token" };

describe("OIDC Signal push boundary", () => {
  it("commits and dispatches before acknowledging", async () => {
    const { app, config } = fixture();
    const response = await app.inject({ method: "POST", url: "/internal/pubsub/signals", headers, payload: push() });
    expect(response.statusCode).toBe(204);
    expect(config.identity.verify).toHaveBeenCalledWith("test-service-token", config.audience, config.pushEmail);
    expect(config.store.ingest).toHaveBeenCalledWith(signal);
    expect(config.store.publishPending).toHaveBeenCalledWith(config.publish);
  });
  it.each([
    ["PR #47 rain rate", pr47RainRateSignal],
    ["PR #47 rain accumulation", pr47RainAccumulationSignal],
    ["PR #47 pump", pr47PumpSignal],
  ] as const)(
    "accepts the published %s Signal shape",
    async (_name, sample) => {
      const { app, config } = fixture();
      const response = await app.inject({ method: "POST", url: "/internal/pubsub/signals", headers, payload: push(sample) });
      expect(response.statusCode).toBe(204);
      expect(config.store.ingest).toHaveBeenCalledWith(sample);
    },
  );
  it.each([undefined, "Basic token", "Bearer token trailing"])("rejects missing or invalid authorization %s", async (authorization) => {
    const { app, config } = fixture();
    const response = await app.inject({ method: "POST", url: "/internal/pubsub/signals", headers: authorization ? { authorization } : {}, payload: push() });
    expect(response.statusCode).toBe(401); expect(config.store.ingest).not.toHaveBeenCalled();
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({ type: "about:blank", status: 401, code: "unauthenticated" });
  });
  it("rejects an invalid signed identity before parsing body", async () => {
    const { app, config } = fixture(); vi.mocked(config.identity.verify).mockRejectedValue(new Error("wrong audience"));
    const response = await app.inject({ method: "POST", url: "/internal/pubsub/signals", headers, payload: push() });
    expect(response.statusCode).toBe(401); expect(config.store.ingest).not.toHaveBeenCalled();
  });
  it.each(["subscription", "base64", "json", "utf8", "schema", "oversize"])("rejects malformed %s", async (kind) => {
    const { app, config } = fixture(); const body = push();
    if (kind === "subscription") body.subscription = "other";
    if (kind === "base64") body.message.data += "!";
    if (kind === "json") body.message.data = Buffer.from("{invalid}").toString("base64");
    if (kind === "utf8") body.message.data = Buffer.from([255, 255, 255]).toString("base64");
    if (kind === "schema") body.message.data = Buffer.from(JSON.stringify({ ...signal, simulated: undefined })).toString("base64");
    if (kind === "oversize") body.message.data = Buffer.alloc(262145).toString("base64");
    const response = await app.inject({ method: "POST", url: "/internal/pubsub/signals", headers, payload: body });
    expect(response.statusCode).toBe(400); expect(config.store.ingest).not.toHaveBeenCalled();
  });
  it.each(["orgId", "environment", "signalId", "simulated", "classification", "schemaVersion"])("rejects mismatched %s provenance", async (field) => {
    const { app, config } = fixture(); const body = push(); body.message.attributes[field] = "unexpected";
    const response = await app.inject({ method: "POST", url: "/internal/pubsub/signals", headers, payload: body });
    expect(response.statusCode).toBe(403); expect(config.store.ingest).not.toHaveBeenCalled();
  });
  it("rejects real-labelled observations in simulation", async () => {
    const { app } = fixture(); const response = await app.inject({ method: "POST", url: "/internal/pubsub/signals", headers, payload: push({ ...signal, simulated: false }) });
    expect(response.statusCode).toBe(403);
  });
  it("leaves a publish failure unacknowledged for retry", async () => {
    const { app, config } = fixture(); vi.mocked(config.store.publishPending).mockRejectedValue(new Error("Pub/Sub unavailable"));
    const response = await app.inject({ method: "POST", url: "/internal/pubsub/signals", headers, payload: push() });
    expect(response.statusCode).toBe(503); expect(response.body).not.toContain("Pub/Sub unavailable");
  });
  it("reports conflicting producer identity as 409", async () => {
    const { app, config } = fixture(); vi.mocked(config.store.ingest).mockRejectedValue(new WorkerError("Signal conflict", 409));
    expect((await app.inject({ method: "POST", url: "/internal/pubsub/signals", headers, payload: push() })).statusCode).toBe(409);
  });
  it("uses the separate Scheduler identity for source checks", async () => {
    const { app, config } = fixture(); const response = await app.inject({ method: "POST", url: "/internal/jobs/silent-sources", headers });
    expect(response.json()).toEqual({ changed: 1 });
    expect(config.identity.verify).toHaveBeenCalledWith("test-service-token", config.audience, config.schedulerEmail);
    expect(config.store.detectSilence).toHaveBeenCalledWith(expect.any(Date));
  });
  it("ages Evidence through the authenticated hourly Scheduler route", async () => {
    const { app, config } = fixture();
    const response = await app.inject({ method: "POST", url: "/internal/jobs/ageing", headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ changed: 1, notified: 2 });
    expect(config.identity.verify).toHaveBeenCalledWith("test-service-token", config.audience, config.schedulerEmail);
    expect(config.store.ageEvidence).toHaveBeenCalledWith(expect.any(Date));
    expect(config.store.publishPending).toHaveBeenCalledWith(config.publish);
  });
  it("rejects Evidence ageing without Scheduler OIDC", async () => {
    const { app, config } = fixture();
    const response = await app.inject({ method: "POST", url: "/internal/jobs/ageing" });
    expect(response.statusCode).toBe(401);
    expect(config.store.ageEvidence).not.toHaveBeenCalled();
  });
  it("fails closed while scaffold health is available", async () => {
    const app = buildApp(); apps.push(app);
    expect((await app.inject({ method: "POST", url: "/internal/pubsub/signals", headers, payload: push() })).statusCode).toBe(503);
  });
});
