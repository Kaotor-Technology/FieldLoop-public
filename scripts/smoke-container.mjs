import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";

const [app, image] = process.argv.slice(2);
assert.ok(["web", "api", "guardrail", "signal-worker", "assistant", "simulator"].includes(app), "Unknown app");
assert.ok(image, "Supply an image tag");
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const user = docker("image", "inspect", image, "--format", "{{.Config.User}}");
assert.ok(user && !["0", "root"].includes(user.split(":")[0]), "Runtime must use a non-root user");
const id = docker("run", "--detach", "--publish", "127.0.0.1::8080", image);
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
  }
  console.log(`${app}: container smoke test passed (non-root, HTTP${app === "api" ? ", SPA assets" : ""}).`);
} catch (error) {
  console.error(docker("logs", id));
  throw error;
} finally {
  docker("rm", "--force", id);
}
