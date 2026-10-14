import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";

const [app, image] = process.argv.slice(2);
assert.ok(["web", "api", "guardrail", "signal-worker", "assistant", "simulator"].includes(app), "Unknown app");
assert.ok(image, "Supply an image tag");
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const user = docker("image", "inspect", image, "--format", "{{.Config.User}}");
assert.ok(user && !["0", "root"].includes(user.split(":")[0]), "Runtime must use a non-root user");
// Catalog target validation needs the seeded database; this smoke checks only
// process startup and health, while scenario validity is covered separately.
const simulatorArgs = app === "simulator" ? ["--env", "FIELDLOOP_SCENARIO_DIR=/tmp"] : [];
const id = docker("run", "--detach", ...simulatorArgs, "--publish", "127.0.0.1::8080", image);
try {
  const port = docker("port", id, "8080/tcp").split(":").at(-1);
  const origin = `http://127.0.0.1:${port}`;
  let response;
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      response = await fetch(`${origin}${app === "web" ? "/" : "/healthz"}`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) break;
    } catch (error) {
      lastError = error;
    }
    await setTimeout(500);
  }
  assert.ok(response?.ok, `Container failed to start: ${String(lastError)}`);
  if (app !== "web") assert.deepEqual(await response.json(), { status: "ok" });
  if (app === "web" || app === "api") {
    const page = await fetch(`${origin}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('<div id="root">'), "Built SPA must be served");
    const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
    assert.ok(asset, "Built SPA must link to its JavaScript");
    const script = await fetch(`${origin}${asset}`);
    assert.equal(script.status, 200);
    assert.ok((await script.text()).length > 0);
    if (app === "api") {
      // Without auth configuration the reference must fail closed, not serve its
      // document or source through the public SPA/static handler.
      for (const path of ["/api/reference/", "/api/reference/openapi.json", "/api/reference/reference.css"]) {
        const reference = await fetch(`${origin}${path}`, { redirect: "manual" });
        assert.equal(reference.status, 503);
        assert.equal(reference.headers.get("cache-control"), "private, no-store");
        assert.equal((await reference.json()).code, "service_unavailable");
      }
    }
  }
  console.log(`${app}: container smoke test passed (non-root, HTTP${app === "api" ? ", SPA assets" : ""}).`);
} catch (error) {
  console.error(docker("logs", id));
  throw error;
} finally {
  docker("rm", "--force", id);
}
