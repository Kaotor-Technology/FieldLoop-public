import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.js";
import { registerSpa } from "../src/spa.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((close) => close())); });

it("serves a direct /map navigation without exposing the SPA at missing API paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "fieldloop-spa-"));
  await writeFile(join(root, "index.html"), '<html><div id="root"></div></html>');
  const app = buildApp();
  cleanup.push(() => app.close(), () => rm(root, { recursive: true, force: true }));
  await registerSpa(app, root);
  const map = await app.inject("/map?selected=synthetic-asset");
  expect(map.statusCode).toBe(200);
  expect(map.headers["content-type"]).toContain("text/html");
  expect(map.body).toContain('id="root"');
  const api = await app.inject({ url: "/api/v1/missing", headers: { accept: "text/html" } });
  expect(api.statusCode).toBe(404);
  expect(api.body).not.toContain('id="root"');
});
