import { afterEach, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app.js";
import { registerSpa } from "../src/spa.js";
import { registerReference } from "../src/reference.js";
import { AuthError, type AuthServicePort, type CurrentUser } from "../src/auth/service.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function fixture() {
  let active = true;
  let available = true;
  const user: CurrentUser = {
    sub: "synthetic-viewer", roles: ["fieldloop.viewer"], persona: "Executive",
    orgId: "fieldloop-demo", clearance: "INTERNAL", csrfToken: "synthetic-csrf", authTime: new Date(),
  };
  const unused = async (): Promise<never> => { throw new Error("Not used by reference tests"); };
  const auth: AuthServicePort = {
    startLogin: unused, startReauthentication: unused, completeLogin: unused,
    issueInternalUserToken: unused, logout: unused, backchannelLogout: unused, jwks: unused,
    getCurrentUser: async (cookie: string | undefined): Promise<CurrentUser> => {
      if (!available) throw new AuthError("SSO unavailable", 503);
      if (!active || cookie !== "synthetic-session") throw new AuthError("Sign-in required", 401);
      return user;
    },
  };
  const getCurrentUser = vi.spyOn(auth, "getCurrentUser");
  const app = buildApp({ auth });
  apps.push(app);
  await registerReference(app, fileURLToPath(new URL("../../../packages/contracts/dist/reference/", import.meta.url)));
  await registerSpa(app, fileURLToPath(new URL("../../web/dist/", import.meta.url)));
  return { app, getCurrentUser, revoke: () => { active = false; }, unavailable: () => { available = false; } };
}

it("redirects signed-out document navigation to SSO and never exposes spec or assets anonymously", async () => {
  const { app } = await fixture();
  for (const url of ["/api/reference", "/api/reference/", "/api/reference/index.html"]) {
    const result = await app.inject(url);
    expect(result.statusCode).toBe(302);
    expect(result.headers.location).toBe("/api/auth/login?return=%2Fapi%2Freference%2F");
    expect(result.body).not.toContain("FieldLoop API");
  }
  for (const file of ["openapi.yaml", "openapi.json", "reference.css", "reference.js", "ibm-plex-mono-latin-400-normal.woff2", "ibm-plex-sans-thai-thai-400-normal.woff2", "ibm-plex-sans-thai-latin-400-normal.woff2"]) {
    const result = await app.inject(`/api/reference/${file}`);
    expect(result.statusCode).toBe(401);
    expect(result.headers["content-type"]).toContain("application/problem+json");
    expect(result.headers["cache-control"]).toBe("private, no-store");
  }
});

it("serves built reference behind the cookie session with no-store and same-origin CSP", async () => {
  const { app, getCurrentUser } = await fixture();
  for (const [file, type] of [["", "text/html"], ["openapi.yaml", "application/yaml"], ["openapi.json", "application/json"], ["reference.css", "text/css"], ["reference.js", "text/javascript"], ["ibm-plex-mono-latin-400-normal.woff2", "font/woff2"]]) {
    const result = await app.inject({ url: `/api/reference/${file}`, cookies: { fl_session: "synthetic-session" } });
    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toContain(type);
    expect(result.headers["cache-control"]).toBe("private, no-store");
    expect(result.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(result.headers["x-content-type-options"]).toBe("nosniff");
    expect(result.headers["x-robots-tag"]).toBe("noindex, nofollow");
  }
  expect(getCurrentUser).toHaveBeenCalledWith("synthetic-session", false);
});

it("fails closed after revocation or auth outage and rejects bearer-only and encoded asset bypasses", async () => {
  const { app, revoke, unavailable } = await fixture();
  const encoded = await app.inject({ url: "/%61pi/reference/openapi.json", headers: { authorization: "Bearer synthetic-token" } });
  expect(encoded.statusCode).toBe(401);
  revoke();
  expect((await app.inject({ url: "/api/reference/openapi.json", cookies: { fl_session: "synthetic-session" } })).statusCode).toBe(401);
  unavailable();
  expect((await app.inject({ url: "/api/reference/", cookies: { fl_session: "synthetic-session" } })).statusCode).toBe(503);
});

it("has no wildcard file or public SPA fallback, and fails startup when reference output is missing", async () => {
  const { app } = await fixture();
  for (const url of ["/api/reference/missing", "/api/reference/manifest.json", "/reference/openapi.yaml"]) {
    const result = await app.inject({ url, cookies: { fl_session: "synthetic-session" } });
    expect(result.statusCode).toBe(404);
    expect(result.body).not.toContain("FieldLoop API");
  }
  const missing = buildApp();
  apps.push(missing);
  await expect(registerReference(missing, fileURLToPath(new URL("./missing-reference/", import.meta.url)))).rejects.toThrow();
});
