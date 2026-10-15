import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { RouteOptions } from "fastify";
import { undocumentedRoutes } from "../../../scripts/openapi-coverage.js";

const { registered } = vi.hoisted(() => ({ registered: [] as Pick<RouteOptions, "method" | "url">[] }));
vi.mock("fastify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fastify")>();
  return { ...actual, default: (options?: import("fastify").FastifyServerOptions) => {
    const app = actual.default({ ...options, exposeHeadRoutes: false });
    app.addHook("onRoute", (route) => { registered.push({ method: route.method, url: route.url }); });
    return app;
  } };
});
import { buildApp } from "../src/app.js";

const spec = JSON.parse(readFileSync(new URL("../../../packages/contracts/dist/reference/openapi.json", import.meta.url), "utf8"));
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); registered.length = 0; });

async function routes() {
  const app = buildApp();
  apps.push(app);
  await app.ready();
  return registered;
}

it("documents every registered versioned BFF operation in the generated reference", async () => {
  const current = await routes();
  expect(current.filter(route => route.url.startsWith("/api/v1/")).length).toBeGreaterThan(20);
  expect(undocumentedRoutes(current, spec)).toEqual([]);
});

it("fails coverage when a newly registered demo operation has no spec entry", async () => {
  const app = buildApp();
  apps.push(app);
  app.post("/api/v1/synthetic-undocumented", async () => ({}));
  await app.ready();
  expect(undocumentedRoutes(registered, spec)).toContain("POST /v1/synthetic-undocumented");
});

it("fails coverage when an implemented operation is removed from the reference", async () => {
  const current = await routes();
  const changed = structuredClone(spec);
  delete changed.paths["/v1/action-requests"].post;
  expect(undocumentedRoutes(current, changed)).toContain("POST /v1/action-requests");
});

it("normalizes parameter names and the BFF prefix without accepting a different method", () => {
  const current = [{ method: "GET", url: "/api/v1/items/:itemId([0-9a-fA-F-]{36})::inspect" }, { method: "POST", url: "/api/v1/items/:itemId([0-9a-fA-F-]{36})::inspect" }];
  expect(undocumentedRoutes(current, { paths: { "/v1/items/{id}:inspect": { get: {} } } })).toEqual(["POST /v1/items/{}:inspect"]);
});

it("detects an explicitly registered HEAD operation without a contract", async () => {
  const app = buildApp();
  apps.push(app);
  app.head("/api/v1/synthetic-undocumented", async () => ({}));
  await app.ready();
  expect(undocumentedRoutes(registered, spec)).toContain("HEAD /v1/synthetic-undocumented");
});
