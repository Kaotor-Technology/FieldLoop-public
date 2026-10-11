import { expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { AuthServicePort } from "../src/auth/service.js";
import { KeycloakOidcProvider } from "../src/auth/keycloak-oidc.js";

vi.mock("openid-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("openid-client")>();
  return {
    ...original,
    discovery: async () => new original.Configuration({
      issuer: "https://sso.example/realm",
      end_session_endpoint: "https://sso.example/realm/logout",
    }, "kaotor-fieldloop"),
  };
});

it("returns a browser logout destination without giving JavaScript an ID token", async () => {
  const provider = new KeycloakOidcProvider("https://sso.example/realm", "kaotor-fieldloop", async () => "server-secret");
  const destination = await provider.endSessionUrl("server-only-id-token", "https://fieldloop.example/");
  expect(destination.searchParams.has("id_token_hint")).toBe(false);
  expect(destination.searchParams.get("client_id")).toBe("kaotor-fieldloop");
  expect(destination.searchParams.get("post_logout_redirect_uri")).toBe("https://fieldloop.example/");

  const unused = async (): Promise<never> => { throw new Error("Unexpected test call"); };
  const auth: AuthServicePort = {
    startLogin: unused, startReauthentication: unused, completeLogin: unused,
    issueInternalUserToken: unused, backchannelLogout: unused, jwks: unused,
    getCurrentUser: async () => ({ sub: "synthetic-subject", roles: ["fieldloop.viewer"], persona: "Executive", orgId: "synthetic-org", clearance: "INTERNAL", csrfToken: "csrf-value", authTime: new Date() }),
    logout: async () => destination,
  };
  const app = buildApp({ auth });
  try {
    const noCsrf = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { accept: "application/json" } });
    expect(noCsrf.statusCode).toBe(403);
    const result = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { accept: "application/json", "x-csrf-token": "csrf-value" } });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ redirectUrl: destination.toString() });
    expect(result.body).not.toContain("server-only-id-token");
    expect(result.headers["set-cookie"]).toContain("fl_session=;");
    expect(result.headers["cache-control"]).toBe("no-store");
  } finally { await app.close(); }
});
