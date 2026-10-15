import { afterEach, expect, it, vi } from "vitest";
import type { ActionServicePort } from "@fieldloop/adapters";
import { buildApp } from "../src/app.js";
import type { GuardrailDependencies } from "../src/model.js";
import { InvalidInternalUserTokenError } from "../src/internal-user-token.js";
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
function fixture() {
  const user = { sub: "synthetic-owner", orgId: "synthetic-org", roles: ["fieldloop.operator"], clearance: "HIGHLY_RESTRICTED" as const };
  const actions: ActionServicePort = { create: vi.fn(), list: vi.fn(), get: vi.fn(), check: vi.fn().mockResolvedValue({ decision: "allow", reason: "registered_read" }), expire: vi.fn() };
  const dependencies: GuardrailDependencies = { actions, orgId: user.orgId, simulated: true, vertexModels: { flash: "synthetic-flash", pro: "synthetic-pro" },
    store: { loadSystem: vi.fn(), recordIntercept: vi.fn(), getContentScan: vi.fn(), recordContentScan: vi.fn() },
    scanner: { scanUserPrompt: vi.fn(), scanModelResponse: vi.fn() }, model: { complete: vi.fn() },
    userTokenVerifier: { verify: async token => { if (token !== "synthetic-internal-token") throw new InvalidInternalUserTokenError(); return user; } },
  };
  const app = buildApp(dependencies); apps.push(app);
  const body = { aiSystem: "synthetic-ai", tool: "get_asset", target: "fieldloop", simulated: true, classification: "INTERNAL" };
  const headers = { "x-fieldloop-internal-user-token": "synthetic-internal-token", "idempotency-key": "synthetic-tool-key" };
  return { app, body, headers, user, actions, dependencies };
}
it("verifies internal identity then checks without invoking models or a target tool", async () => {
  const { app, body, headers, user, actions, dependencies } = fixture();
  const response = await app.inject({ method: "POST", url: "/guardrail/v1/tool-calls:check", payload: body, headers });
  expect(response.statusCode).toBe(200); expect(response.json().decision).toBe("allow");
  expect(actions.check).toHaveBeenCalledWith(user, body, headers["idempotency-key"]);
  expect(dependencies.model.complete).not.toHaveBeenCalled();
  expect(dependencies.scanner.scanUserPrompt).not.toHaveBeenCalled();
});
it("fails closed on missing/forged/cross-Organisation tokens, key, L3 and real-data scope", async () => {
  const { app, body, headers, user, actions } = fixture();
  const request = (payload: object, h: Record<string,string>) => app.inject({ method: "POST", url: "/guardrail/v1/tool-calls:check", payload, headers:h });
  expect((await request(body,{})).statusCode).toBe(401);
  expect((await request(body,{ ...headers, "x-fieldloop-internal-user-token": "forged-internal-token" })).statusCode).toBe(401);
  user.orgId="another-org"; expect((await request(body,headers)).statusCode).toBe(403); user.orgId="synthetic-org";
  expect((await request(body,{ "x-fieldloop-internal-user-token": headers["x-fieldloop-internal-user-token"] })).statusCode).toBe(400);
  expect((await request({ ...body,actionLevel:"l3" },headers)).statusCode).toBe(400);
  expect((await request({ ...body,simulated:false },headers)).statusCode).toBe(400);
  expect(actions.check).not.toHaveBeenCalled();
});
it("never allows a call after persistence fails and does not expose storage details", async () => {
  const { app, body, headers, actions } = fixture();
  vi.mocked(actions.check).mockRejectedValue(new Error("synthetic database secret"));
  const response=await app.inject({ method:"POST",url:"/guardrail/v1/tool-calls:check",payload:body,headers });
  expect(response.statusCode).toBe(503); expect(response.headers["content-type"]).toContain("application/problem+json");
  expect(response.body).not.toContain("synthetic database secret");
});
