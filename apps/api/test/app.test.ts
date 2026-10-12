import { afterEach, describe, expect, it } from "vitest";
import { buildApp, serializeRequestForLog } from "../src/app.js";

const app = buildApp();
afterEach(async () => { await app.close(); });

describe("service scaffold", () => {
  it("answers local and Cloud Run health probes without external dependencies", async () => {
    for (const url of ["/healthz", "/health"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ok" });
    }
  });

  it("keeps the OIDC authorization code and state out of request logs", () => {
    const logged = serializeRequestForLog({
      method: "GET",
      url: "/api/auth/callback?code=authorization-code&state=one-time-state",
      host: "fieldloop-dev.kaotor.com",
      ip: "127.0.0.1",
    });

    expect(logged.url).toBe("/api/auth/callback");
    expect(JSON.stringify(logged)).not.toContain("authorization-code");
  });
});
