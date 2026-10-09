import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

const app = buildApp();
afterEach(async () => { await app.close(); });

describe("service scaffold", () => {
  it("starts and answers a health probe without external dependencies", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});
