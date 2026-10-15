import { expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { WorkerRuntime } from "../src/model.js";
it("accepts only the configured Scheduler identity and expires with server time", async () => {
  const expireActions = vi.fn().mockResolvedValue(2);
  const identity = { verify: vi.fn(async (token, _audience, email) => { if (token !== "scheduler-token" || email !== "scheduler@example.invalid") throw new Error("Rejected"); }) };
  const runtime: WorkerRuntime = { expireActions, identity, audience: "synthetic-audience", schedulerEmail: "scheduler@example.invalid", pushEmail: "push@example.invalid", orgId: "synthetic-org", environment: "local", simulatedOnly: true, subscription: "synthetic-subscription", close: async () => {}, publish: vi.fn(), store: { ingest: vi.fn(), detectSilence: vi.fn(), ageEvidence: vi.fn(), publishPending: vi.fn() } };
  const app = buildApp(runtime);
  try {
    expect((await app.inject({ method:"POST", url:"/internal/jobs/sla-expiry" })).statusCode).toBe(401);
    expect((await app.inject({ method:"POST", url:"/internal/jobs/sla-expiry", headers:{authorization:"Bearer push-token"} })).statusCode).toBe(401);
    expect(expireActions).not.toHaveBeenCalled();
    const response=await app.inject({ method:"POST", url:"/internal/jobs/sla-expiry", headers:{authorization:"Bearer scheduler-token"} });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ rejected:2 });
    expect(identity.verify).toHaveBeenLastCalledWith("scheduler-token","synthetic-audience","scheduler@example.invalid");
    expect(expireActions).toHaveBeenCalledWith();
  } finally { await app.close(); }
});
