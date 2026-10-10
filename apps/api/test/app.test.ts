import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

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
});
