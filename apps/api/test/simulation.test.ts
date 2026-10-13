import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { AuthError, type AuthServicePort, type CurrentUser } from "../src/auth/service.js";
import { RemoteSimulationClient, type SimulationPort, type SimulationRun } from "../src/simulation/client.js";
import type { RiskEvent, RiskApiPort } from "../src/risk/service.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
function fixture(riskEvent?: RiskEvent) {
  const user: CurrentUser = { sub: "synthetic-operator", roles: ["fieldloop.operator"], persona: "Integrity Engineer", orgId: "test-org", clearance: "HIGHLY_RESTRICTED", csrfToken: "fixture-csrf", authTime: new Date("2026-10-13T00:00:00Z") };
  const auth: AuthServicePort = {
    getCurrentUser: async (cookie) => { if (cookie !== "valid") throw new AuthError("Session required", 401); return user; },
    startLogin: async () => new URL("https://example.test"), startReauthentication: async () => new URL("https://example.test"),
    completeLogin: async () => { throw new Error("unused"); }, issueInternalUserToken: async () => { throw new Error("unused"); },
    logout: async () => new URL("https://example.test"), backchannelLogout: async () => {}, jwks: async () => ({ keys: [] }),
  };
  let run: SimulationRun | null = null;
  const commands: string[] = [];
  const simulator: SimulationPort = {
    orgId: "test-org",
    scenarios: async () => [{ id: "player-test", name: "Player verification fixture", version: "1", durationSeconds: 120, simulated: true, classification: "HIGHLY_RESTRICTED" }],
    current: async () => run,
    read: async () => { if (!run) throw new Error("unused"); return run; },
    create: async (body) => {
      run = { revision: 1, id: randomUUID(), orgId: "test-org", scenarioId: body.scenarioId, scenarioName: "Player verification fixture", seed: body.seed, speed: body.speed, clock: "2026-10-13T00:00:00Z", elapsedSeconds: 0, durationSeconds: 120, state: "ready", nextEventIndex: 0, eventCount: 3, simulated: true, classification: "HIGHLY_RESTRICTED", bookmarks: [] };
      return run;
    },
    command: async (_id, command) => {
      if (!run) throw new Error("unused");
      commands.push(command);
      if (command === "reset") run = { ...run, id: randomUUID(), revision: run.revision + 1, state: "ready" };
      else if (command === "play") run = { ...run, state: "playing" };
      return run;
    },
  };
  let riskEventSent = false;
  const risk: RiskApiPort = {
    listBowties: async () => [],
    getBowtie: async () => { throw new Error("unused"); },
    getRisk: async () => { throw new Error("unused"); },
    explain: async () => { throw new Error("unused"); },
    getEvidence: async () => { throw new Error("unused"); },
    riskEventsAfter: async () => {
      if (!riskEvent || riskEventSent) return [];
      riskEventSent = true;
      return [riskEvent];
    },
    processHealthChanges: async () => 0,
  };
  const app = buildApp({ auth, simulator, risk }); apps.push(app);
  const headers = { cookie: "fl_session=valid", "x-csrf-token": "fixture-csrf", "idempotency-key": "test-player-request-01" };
  return { app, user, simulator, headers, commands };
}

it("protects controls with session, CSRF, role, Organisation and clearance", async () => {
  const { app, user, headers, commands } = fixture();
  const url = "/api/v1/simulation/runs";
  const payload = { scenarioId: "player-test", seed: 42, speed: 1 };
  expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(401);
  expect((await app.inject({ method: "POST", url, payload, headers: { cookie: headers.cookie } })).statusCode).toBe(403);
  user.roles = ["fieldloop.viewer"];
  expect((await app.inject({ method: "POST", url, payload, headers })).statusCode).toBe(403);
  user.roles = ["fieldloop.operator"]; user.orgId = "another-org";
  expect((await app.inject({ method: "POST", url, payload, headers })).statusCode).toBe(403);
  user.orgId = "test-org"; user.clearance = "INTERNAL";
  expect((await app.inject({ method: "GET", url: "/api/v1/scenarios", headers })).json()).toEqual([]);
  expect((await app.inject({ method: "POST", url, payload, headers })).statusCode).toBe(403);
  user.clearance = "HIGHLY_RESTRICTED";
  const created = await app.inject({ method: "POST", url, payload, headers });
  expect(created.statusCode).toBe(200);
  for (const command of ["play", "pause", "step", "speed", "bookmark", "reset"] as const) {
    const result = await app.inject({ method: "POST", url: `${url}/${created.json().id}:${command}`, payload: {}, headers });
    expect(result.statusCode).toBe(200);
  }
  expect(commands).toEqual(["play", "pause", "step", "speed", "bookmark", "reset"]);
});

it("rejects malformed wire fields and missing idempotency before forwarding effects", async () => {
  const { app, headers } = fixture();
  for (const payload of [{ scenarioId: "player-test", seed: true, speed: 1 }, { scenarioId: "player-test", seed: 42, speed: "1" }, { scenarioId: "player-test", seed: 42, speed: 1, simulated: false }]) {
    const result = await app.inject({ method: "POST", url: "/api/v1/simulation/runs", payload, headers });
    expect(result.statusCode).toBe(400); expect(result.headers["content-type"]).toContain("application/problem+json");
  }
  expect((await app.inject({ method: "POST", url: "/api/v1/simulation/runs", payload: { scenarioId: "player-test", seed: 42, speed: 1 }, headers: { cookie: headers.cookie, "x-csrf-token": headers["x-csrf-token"] } })).statusCode).toBe(400);
});

it("emits reset over SSE and detects a reset across a reconnect", async () => {
  const { app, headers, simulator } = fixture();
  const first = await simulator.create({ scenarioId: "player-test", seed: 42, speed: 1 }, "fixture");
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  const abort = new AbortController();
  const response = await fetch(`${base}/api/v1/events`, { headers: { cookie: headers.cookie }, signal: abort.signal });
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  if (!response.body) throw new Error("SSE response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  async function until(value: string) {
    let text = "";
    while (!text.includes(value)) { const chunk = await reader.read(); if (chunk.done) throw new Error("Stream ended early"); text += decoder.decode(chunk.value); }
    return text;
  }
  await until("event: simulation.state");
  const started = performance.now();
  await simulator.command(first.id, "reset", {}, "fixture-reset");
  await until("event: simulation.reset");
  expect(performance.now() - started).toBeLessThan(1000);
  await reader.cancel(); abort.abort();
  const reconnect = new AbortController();
  const resumed = await fetch(`${base}/api/v1/events`, { headers: { cookie: headers.cookie, "last-event-id": `${first.id}:0` }, signal: reconnect.signal });
  if (!resumed.body) throw new Error("SSE response has no body");
  const resumedReader = resumed.body.getReader(); let text = "";
  while (!text.includes("event: simulation.reset")) { const chunk = await resumedReader.read(); if (chunk.done) throw new Error("Stream ended"); text += decoder.decode(chunk.value); }
  await resumedReader.cancel(); reconnect.abort();
});

it("emits risk recalculation snapshots over SSE with a resumable cursor", async () => {
  const bowtieId = randomUUID();
  const consequenceId = randomUUID();
  const snapshotId = randomUUID();
  const createdAt = new Date().toISOString();
  const cell = { frequencyBand: 1 as const, severityBand: 1 as const, zone: "green" as const, rank: 1 };
  const event: RiskEvent = {
    id: snapshotId, createdAt, bowtieId, snapshotId, trigger: "health_change",
    calibration: { standardRef: "SYNTHETIC-ORG-RISK-STD", standardVersion: "2026.1", approvedBy: "synthetic-authority", approvedAt: createdAt },
    snapshot: {
      bowtieId, topEventFrequencyPerYear: 0.001, threats: [],
      consequences: [{
        consequenceId, frequencyPerYear: 0.0001, severityBand: 1,
        path: { pathId: `mitigative:${consequenceId}`, targetId: consequenceId, pfd: 0.1, barriers: [] },
        cell,
      }],
      worstConsequenceId: consequenceId, cell,
    },
  };
  const { app, headers } = fixture(event);
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  const abort = new AbortController();
  const response = await fetch(`${base}/api/v1/events`, { headers: { cookie: headers.cookie }, signal: abort.signal });
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  if (!response.body) throw new Error("SSE response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("event: risk.recalculated")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("Risk event stream ended early");
    text += decoder.decode(chunk.value);
  }
  expect(text).toContain(`id: risk:${createdAt}:${snapshotId}`);
  expect(text).toContain(`"bowtieId":"${bowtieId}"`);
  expect(text).toContain('"trigger":"health_change"');
  await reader.cancel();
  abort.abort();
});

it("uses the generated client and rejects invalid upstream envelopes", async () => {
  const client = new RemoteSimulationClient("http://127.0.0.1:8081", "test-org", async (request) => {
    expect(new URL(request.url).pathname).toBe("/v1/simulation/runs/current");
    return Response.json({ simulated: false });
  });
  await expect(client.current()).rejects.toMatchObject({ status: 503, code: "invalid_simulation_response" });
});
