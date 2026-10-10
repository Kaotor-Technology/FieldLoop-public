import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { AuthError, BffAuthService, csrfMatches, hash, safeReturnPath, type AuthServicePort } from "../src/auth/service.js";
import {
  OidcRejectedError,
  type AuthStore,
  type AuthUser,
  type EnvelopeCrypto,
  type InternalTokenService,
  type LoginTokens,
  type OidcProvider,
  type OidcTransaction,
} from "../src/auth/model.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function makeApp(auth: AuthServicePort) {
  const app = buildApp({ auth, baseUrl: "https://fieldloop-dev.kaotor.com" });
  apps.push(app);
  return app;
}

describe("BFF auth routes", () => {
  it("redirects login only to a same-origin return path", async () => {
    const startLogin = vi.fn(async () => new URL("https://auth.example.com/authorize"));
    const auth = routeAuth({ startLogin });
    const response = await makeApp(auth).inject({ method: "GET", url: "/api/auth/login?return=https%3A%2F%2Fevil.example" });

    expect(startLogin).toHaveBeenCalledWith("/");
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://auth.example.com/authorize");
  });

  it("sets only the opaque HttpOnly session cookie after callback", async () => {
    const completeLogin = vi.fn(async () => ({
      sessionCookieValue: "opaque-session-value",
      returnPath: "/map?domain=synthetic",
      authTime: new Date("2026-10-10T00:00:00Z"),
    }));
    const response = await makeApp(routeAuth({ completeLogin })).inject({
      method: "GET",
      url: "/api/auth/callback?code=authorization-code&state=one-time-state",
    });

    const cookieHeader = response.headers["set-cookie"];
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("https://fieldloop-dev.kaotor.com/map?domain=synthetic");
    const cookies = Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader ?? "";
    expect(cookies).toContain("fl_session=opaque-session-value");
    expect(cookies).toContain("HttpOnly");
    expect(cookies).toContain("Secure");
    expect(cookies).toContain("SameSite=Lax");
    expect(response.body).not.toContain("access_token");
    expect(response.body).not.toContain("refresh_token");
  });

  it("rejects a state-changing session request without a CSRF token", async () => {
    const logout = vi.fn(async () => new URL("https://fieldloop-dev.kaotor.com/"));
    const auth = routeAuth({ logout });
    const response = await makeApp(auth).inject({
      method: "POST",
      url: "/api/auth/logout",
      cookies: { fl_session: "opaque-session-value" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("csrf_token_invalid");
    expect(logout).not.toHaveBeenCalled();
  });

  it("accepts Keycloak back-channel logout without a browser session", async () => {
    const backchannelLogout = vi.fn(async () => {});
    const response = await makeApp(routeAuth({ backchannelLogout })).inject({
      method: "POST",
      url: "/api/auth/backchannel-logout",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ logout_token: "signed-keycloak-token" }).toString(),
    });

    expect(response.statusCode).toBe(204);
    expect(backchannelLogout).toHaveBeenCalledWith("signed-keycloak-token");
  });

  it("returns the current BFF identity and its CSRF token", async () => {
    const currentUser = {
      sub: "synthetic-subject",
      roles: ["fieldloop.viewer"],
      persona: "Executive",
      orgId: "fieldloop-demo",
      clearance: "INTERNAL",
      csrfToken: "csrf-value",
      authTime: new Date("2026-10-10T00:00:00Z"),
    };
    const getCurrentUser = vi.fn(async () => currentUser);
    const response = await makeApp(routeAuth({ getCurrentUser })).inject({
      method: "GET",
      url: "/api/v1/me",
      cookies: { fl_session: "opaque-session-value" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ...currentUser, authTime: currentUser.authTime.toISOString() });
    expect(getCurrentUser).toHaveBeenCalledWith("opaque-session-value", false);
  });

  it("protects application routes and requires fresh reauthentication for approval decisions", async () => {
    const getCurrentUser = vi.fn(async () => ({
      sub: "synthetic-subject",
      roles: ["fieldloop.manager"],
      persona: "Technical Authority",
      orgId: "fieldloop-demo",
      clearance: "INTERNAL",
      csrfToken: "csrf-value",
      authTime: new Date(Date.now() - 5 * 60 * 1000),
    }));
    const app = makeApp(routeAuth({ getCurrentUser }));
    app.post("/api/v1/action-requests/action-1:approve", async () => ({ approved: true }));

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/action-requests/action-1:approve",
      cookies: { fl_session: "opaque-session-value" },
      headers: { "x-csrf-token": "csrf-value" },
    });

    expect(getCurrentUser).toHaveBeenCalledWith("opaque-session-value", true);
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("reauthentication_required");
    expect(response.json().title).toBe("Recent reauthentication is required");
  });

  it("requires a session when the /api prefix is percent-encoded", async () => {
    const getCurrentUser = vi.fn(async () => { throw new AuthError("Session required", 401); });
    const app = makeApp(routeAuth({ getCurrentUser }));
    app.get("/api/v1/assets", async () => ({ leaked: true }));

    const response = await app.inject({ method: "GET", url: "/%61pi/v1/assets" });

    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain("leaked");
  });

  it("does not treat a path that merely starts like a public auth route as public", async () => {
    const getCurrentUser = vi.fn(async () => { throw new AuthError("Session required", 401); });
    const app = makeApp(routeAuth({ getCurrentUser }));
    app.get("/api/auth/login-history", async () => ({ leaked: true }));

    const response = await app.inject({ method: "GET", url: "/api/auth/login-history" });

    expect(response.statusCode).toBe(401);
  });

  it.each([
    ["an encoded verb separator", "/api/v1/action-requests/action-1%3Aapprove", "/api/v1/action-requests/action-1:approve"],
    ["the approvals sub-resource", "/api/v1/action-requests/action-1/approvals", "/api/v1/action-requests/:id/approvals"],
    ["a query string", "/api/v1/held-requests/held-1:reject?x=1", "/api/v1/held-requests/held-1:reject"],
  ])("requires fresh reauthentication for a decision sent with %s", async (_label, url, route) => {
    const getCurrentUser = vi.fn(async () => ({
      sub: "synthetic-subject",
      roles: ["fieldloop.manager"],
      persona: "Technical Authority",
      orgId: "fieldloop-demo",
      clearance: "INTERNAL",
      csrfToken: "csrf-value",
      authTime: new Date(Date.now() - 60 * 60 * 1000),
    }));
    const app = makeApp(routeAuth({ getCurrentUser }));
    app.post(route, async () => ({ approved: true }));

    const response = await app.inject({
      method: "POST",
      url,
      cookies: { fl_session: "opaque-session-value" },
      headers: { "x-csrf-token": "csrf-value" },
    });

    expect(getCurrentUser).toHaveBeenCalledWith("opaque-session-value", true);
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("reauthentication_required");
  });

  it("falls back to the root return path when the return parameter is repeated", async () => {
    const startLogin = vi.fn(async () => new URL("https://auth.example.com/authorize"));
    const response = await makeApp(routeAuth({ startLogin })).inject({ method: "GET", url: "/api/auth/login?return=/a&return=/b" });

    expect(response.statusCode).toBe(302);
    expect(startLogin).toHaveBeenCalledWith("/");
  });

  it("answers 400 for a back-channel logout token that fails verification", async () => {
    const backchannelLogout = vi.fn(async () => { throw new AuthError("Invalid back-channel logout token", 400); });
    const response = await makeApp(routeAuth({ backchannelLogout })).inject({
      method: "POST",
      url: "/api/auth/backchannel-logout",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "logout_token=forged",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("validation_failed");
  });

  it("answers 400, not 503, for a back-channel logout body it cannot parse", async () => {
    const response = await makeApp(routeAuth()).inject({
      method: "POST",
      url: "/api/auth/backchannel-logout",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("validation_failed");
  });

  it("leaves health probes available without a session", async () => {
    const getCurrentUser = vi.fn(async () => { throw new Error("should not be called"); });
    const response = await makeApp(routeAuth({ getCurrentUser })).inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(getCurrentUser).not.toHaveBeenCalled();
  });

  it("allows the same-origin SPA shell to load before sign-in", async () => {
    const getCurrentUser = vi.fn(async () => { throw new Error("should not be called"); });
    const app = makeApp(routeAuth({ getCurrentUser }));
    app.get("/", async () => ({ html: true }));
    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    expect(getCurrentUser).not.toHaveBeenCalled();
  });
});

describe("BFF auth service", () => {
  it("stores OIDC state and encrypted PKCE verifier server-side", async () => {
    const store = new TestAuthStore();
    const authorizationUrl = vi.fn(async (input: Parameters<OidcProvider["authorizationUrl"]>[0]) => {
      const url = new URL("https://auth.example.com/authorize");
      const queryNames: Record<string, string> = { redirectUri: "redirect_uri", codeChallenge: "code_challenge" };
      for (const [key, value] of Object.entries(input)) {
        if (value !== undefined) url.searchParams.set(queryNames[key] ?? key, String(value));
      }
      return url;
    });
    const service = createTestService(store, testOidc({ authorizationUrl }));

    const redirect = await service.startLogin("//outside.example/redirect");
    const transaction = [...store.transactions.values()][0];

    expect(transaction).toBeDefined();
    expect(transaction?.returnPath).toBe("/");
    expect(transaction?.stateHash).not.toBe(redirect.searchParams.get("state"));
    expect(transaction?.encryptedCodeVerifier.toString()).toContain("cipher:");
    expect(redirect.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(redirect.searchParams.get("nonce")).toBeTruthy();
    expect(redirect.searchParams.get("state")).toBeTruthy();
  });

  it("stores only encrypted tokens with the fixed org and one of the three supported roles", async () => {
    const store = new TestAuthStore();
    const state = "one-time-state";
    store.transactions.set(hash(state), transactionFixture(state));
    const exchange = vi.fn(async () => tokenFixture("fieldloop.operator"));
    const service = createTestService(store, testOidc({ exchange }));

    const result = await service.completeLogin(new URL(`https://fieldloop-dev.kaotor.com/api/auth/callback?code=code&state=${state}`));
    const saved = store.savedSession;

    expect(result.sessionCookieValue).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(result.returnPath).toBe("/map?domain=synthetic");
    expect(saved?.orgId).toBe("fieldloop-demo");
    expect(saved?.roles).toEqual(["fieldloop.operator"]);
    expect(saved?.accessToken.toString()).not.toContain("access-secret");
    expect(saved?.refreshToken?.toString()).not.toContain("refresh-secret");
    expect(saved?.idToken.toString()).not.toContain("id-secret");
    expect(exchange).toHaveBeenCalledWith(expect.objectContaining({ state, nonce: "test-nonce", codeVerifier: "test-verifier" }));
  });

  it("rejects a Keycloak denial or missing authorization code after consuming state", async () => {
    for (const callback of [
      { query: "error=access_denied", statusCode: 401 },
      { query: "code=", statusCode: 400 },
    ]) {
      const store = new TestAuthStore();
      const state = "one-time-state";
      store.transactions.set(hash(state), transactionFixture(state));
      const exchange = vi.fn(async () => tokenFixture("fieldloop.viewer"));
      const service = createTestService(store, testOidc({ exchange }));

      await expect(
        service.completeLogin(new URL(`https://fieldloop-dev.kaotor.com/api/auth/callback?${callback.query}&state=${state}`)),
      ).rejects.toMatchObject({ statusCode: callback.statusCode });
      expect(store.transactions.size).toBe(0);
      expect(exchange).not.toHaveBeenCalled();
    }
  });

  it("forces Keycloak login and updates the same session on reauthentication", async () => {
    const cookieValue = "opaque-session-value";
    const store = new TestAuthStore(sessionFixture());
    let authorizationState = "";
    const authorizationUrl = vi.fn(async (input: Parameters<OidcProvider["authorizationUrl"]>[0]) => {
      authorizationState = input.state;
      return new URL("https://auth.example.com/authorize");
    });
    const exchange = vi.fn(async () => tokenFixture("fieldloop.manager", "2026-10-10T00:02:00Z"));
    const oidc = testOidc({ authorizationUrl, exchange });
    const service = createTestService(store, oidc);

    await service.startReauthentication(cookieValue, "/approvals");
    const result = await service.completeLogin(
      new URL(`https://fieldloop-dev.kaotor.com/api/auth/callback?code=code&state=${authorizationState}`),
      cookieValue,
    );

    expect(authorizationUrl).toHaveBeenCalledWith(expect.objectContaining({ prompt: "login", maxAge: 0 }));
    expect(exchange).toHaveBeenCalledWith(expect.objectContaining({ maxAge: 0 }));
    expect(result.sessionCookieValue).toBe(cookieValue);
    expect(store.savedSession?.existingSessionHash).toBe(hash(cookieValue));
    expect(store.savedSession?.expiresAt).toEqual(sessionFixture().expiresAt);
    expect(store.savedSession?.roles).toEqual(["fieldloop.manager"]);
  });

  it("rejects reauthentication when Keycloak omits auth_time or it is stale", async () => {
    for (const authTime of ["2026-10-09T23:00:00Z", null]) {
      const cookieValue = "opaque-session-value";
      const store = new TestAuthStore(sessionFixture());
      let authorizationState = "";
      const oidc = testOidc({
        authorizationUrl: async (input) => {
          authorizationState = input.state;
          return new URL("https://auth.example.com/authorize");
        },
        exchange: async () => {
          const tokens = tokenFixture("fieldloop.manager", authTime ?? undefined);
          if (authTime === null) delete tokens.claims["auth_time"];
          return tokens;
        },
      });
      const service = createTestService(store, oidc);
      await service.startReauthentication(cookieValue, "/approvals");

      await expect(
        service.completeLogin(
          new URL(`https://fieldloop-dev.kaotor.com/api/auth/callback?code=code&state=${authorizationState}`),
          cookieValue,
        ),
      ).rejects.toMatchObject({ statusCode: 401 });
      expect(store.savedSession).toBeUndefined();
    }
  });

  it("deletes all sessions for a verified Keycloak sid", async () => {
    const store = new TestAuthStore();
    const service = createTestService(store, testOidc({ verifyBackchannelLogout: async () => ({ sid: "revoked-sid" }) }));
    await service.backchannelLogout("signed-logout-token");
    expect(store.deletedSids).toEqual(["revoked-sid"]);
  });

  it("completes local logout if the Keycloak end-session redirect cannot be built", async () => {
    const cookieValue = "opaque-session-value";
    const store = new TestAuthStore(sessionFixture());
    const service = createTestService(store, testOidc({ endSessionUrl: async () => { throw new Error("IdP unavailable"); } }));

    await expect(service.logout(cookieValue)).resolves.toEqual(new URL("https://fieldloop-dev.kaotor.com/"));
    expect(store.deletedSessions).toEqual([hash(cookieValue)]);
  });

  it("deletes a session and returns 401 when Keycloak introspection is inactive", async () => {
    const store = new TestAuthStore(sessionFixture());
    const oidc = testOidc({ introspect: async () => false });
    const service = new BffAuthService({
      store,
      crypto: testCrypto(),
      oidc,
      internalTokens: testInternalTokens(),
      baseUrl: "https://fieldloop-dev.kaotor.com",
      defaultOrgId: "fieldloop-demo",
      now: () => new Date("2026-10-10T00:02:00Z"),
    });

    await expect(service.getCurrentUser("opaque-session-value")).rejects.toMatchObject({ statusCode: 401 });
    expect(store.deletedSessions).toEqual([hash("opaque-session-value")]);
  });

  it("persists the 60-second introspection cache and forces introspection before refresh for decisions", async () => {
    const store = new TestAuthStore(sessionFixture());
    const events: string[] = [];
    const oidc = testOidc({
      introspect: async () => { events.push("introspect"); return true; },
      refresh: async () => {
        events.push("refresh");
        return { ...tokenFixture("fieldloop.viewer"), expiresIn: 300 };
      },
    });
    const session = store.sessionForTest;
    if (!session) throw new Error("Test session missing");
    session.lastValidatedAt = new Date("2026-10-10T00:00:00Z");
    session.accessExpiresAt = new Date("2026-10-10T00:02:30Z");
    const service = new BffAuthService({
      store,
      crypto: testCrypto(),
      oidc,
      internalTokens: testInternalTokens(),
      baseUrl: "https://fieldloop-dev.kaotor.com",
      defaultOrgId: "fieldloop-demo",
      now: () => new Date("2026-10-10T00:02:00Z"),
    });

    await service.getCurrentUser("opaque-session-value", true);

    expect(events).toEqual(["introspect", "refresh"]);
    expect(store.validationMarks).toEqual([{ sessionHash: hash("opaque-session-value"), lastValidatedAt: new Date("2026-10-10T00:02:00Z") }]);
    expect(store.tokenUpdates).toHaveLength(1);
    expect(store.tokenUpdates[0]?.lastValidatedAt).toEqual(new Date("2026-10-10T00:02:00Z"));
  });

  it("refreshes an expired access token before forced decision introspection", async () => {
    const store = new TestAuthStore(sessionFixture());
    const events: string[] = [];
    const oidc = testOidc({
      introspect: async (accessToken) => { events.push(`introspect:${accessToken}`); return true; },
      refresh: async () => {
        events.push("refresh");
        return { ...tokenFixture("fieldloop.viewer"), expiresIn: 300 };
      },
    });
    const session = store.sessionForTest;
    if (!session) throw new Error("Test session missing");
    session.accessExpiresAt = new Date("2026-10-10T00:01:59Z");
    session.lastValidatedAt = new Date("2026-10-10T00:00:00Z");
    const service = new BffAuthService({
      store,
      crypto: testCrypto(),
      oidc,
      internalTokens: testInternalTokens(),
      baseUrl: "https://fieldloop-dev.kaotor.com",
      defaultOrgId: "fieldloop-demo",
      now: () => new Date("2026-10-10T00:02:00Z"),
    });

    await service.getCurrentUser("opaque-session-value", true);

    expect(events).toEqual(["refresh", "introspect:access-secret"]);
    expect(store.validationMarks).toEqual([{ sessionHash: hash("opaque-session-value"), lastValidatedAt: new Date("2026-10-10T00:02:00Z") }]);
  });

  it("does not extend the introspection cache when only refreshing a token", async () => {
    const store = new TestAuthStore(sessionFixture());
    const oldValidation = new Date("2026-10-10T00:01:30Z");
    const session = store.sessionForTest;
    if (!session) throw new Error("Test session missing");
    session.lastValidatedAt = oldValidation;
    session.accessExpiresAt = new Date("2026-10-10T00:02:30Z");
    const service = new BffAuthService({
      store,
      crypto: testCrypto(),
      oidc: testOidc({ refresh: async () => ({ ...tokenFixture("fieldloop.viewer"), expiresIn: 300 }) }),
      internalTokens: testInternalTokens(),
      baseUrl: "https://fieldloop-dev.kaotor.com",
      defaultOrgId: "fieldloop-demo",
      now: () => new Date("2026-10-10T00:02:00Z"),
    });

    await service.getCurrentUser("opaque-session-value");

    expect(store.tokenUpdates[0]?.lastValidatedAt).toEqual(oldValidation);
    expect(store.validationMarks).toEqual([]);
  });

  it("persists an ordinary introspection result so it is not repeated on the next request", async () => {
    const store = new TestAuthStore(sessionFixture());
    const introspect = vi.fn(async () => true);
    const service = new BffAuthService({
      store,
      crypto: testCrypto(),
      oidc: testOidc({ introspect }),
      internalTokens: testInternalTokens(),
      baseUrl: "https://fieldloop-dev.kaotor.com",
      defaultOrgId: "fieldloop-demo",
      now: () => new Date("2026-10-10T00:02:00Z"),
    });

    await service.getCurrentUser("opaque-session-value");
    await service.getCurrentUser("opaque-session-value");

    expect(introspect).toHaveBeenCalledOnce();
    expect(store.validationMarks).toEqual([{ sessionHash: hash("opaque-session-value"), lastValidatedAt: new Date("2026-10-10T00:02:00Z") }]);
  });

  it("deletes the session and returns 401 when Keycloak rejects the refresh token", async () => {
    const store = new TestAuthStore(sessionFixture());
    const session = store.sessionForTest;
    if (!session) throw new Error("Test session missing");
    session.accessExpiresAt = new Date("2026-10-10T00:01:59Z");
    const service = createTestService(store, testOidc({ refresh: async () => { throw new OidcRejectedError("invalid_grant"); } }));

    await expect(service.getCurrentUser("opaque-session-value")).rejects.toMatchObject({ statusCode: 401, code: "unauthenticated" });
    expect(store.deletedSessions).toEqual([hash("opaque-session-value")]);
  });

  it("keeps the session and fails as unavailable when Keycloak cannot be reached during refresh", async () => {
    const store = new TestAuthStore(sessionFixture());
    const session = store.sessionForTest;
    if (!session) throw new Error("Test session missing");
    session.accessExpiresAt = new Date("2026-10-10T00:01:59Z");
    const service = createTestService(store, testOidc({ refresh: async () => { throw new Error("connect ETIMEDOUT"); } }));

    await expect(service.getCurrentUser("opaque-session-value")).rejects.toThrow("connect ETIMEDOUT");
    expect(store.deletedSessions).toEqual([]);
  });

  it("rejects a back-channel logout token that Keycloak did not sign as a validation failure", async () => {
    const store = new TestAuthStore(sessionFixture());
    const service = createTestService(
      store,
      testOidc({ verifyBackchannelLogout: async () => { throw new OidcRejectedError("bad signature"); } }),
    );

    await expect(service.backchannelLogout("forged-token")).rejects.toMatchObject({ statusCode: 400, code: "validation_failed" });
    expect(store.deletedSids).toEqual([]);
  });

  it("returns 401 when Keycloak rejects the authorization code", async () => {
    const store = new TestAuthStore();
    store.transactions.set(hash("one-time-state"), transactionFixture("one-time-state"));
    const service = createTestService(store, testOidc({ exchange: async () => { throw new OidcRejectedError("invalid_grant"); } }));

    await expect(
      service.completeLogin(new URL("https://fieldloop-dev.kaotor.com/api/auth/callback?code=used-code&state=one-time-state")),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(store.savedSession).toBeUndefined();
  });

  it("uses same-origin return paths and compares CSRF values safely", () => {
    expect(safeReturnPath("/map?tab=health#barrier")).toBe("/map?tab=health#barrier");
    expect(safeReturnPath("//evil.example/steal")).toBe("/");
    expect(safeReturnPath("https://evil.example/steal")).toBe("/");
    expect(csrfMatches("correct-token", "correct-token")).toBe(true);
    expect(csrfMatches("correct-token", "wrong-token")).toBe(false);
  });
});

function routeAuth(overrides: Partial<AuthServicePort> = {}): AuthServicePort {
  const defaultUser = {
    sub: "synthetic-subject",
    roles: ["fieldloop.viewer"],
    persona: "Executive",
    orgId: "fieldloop-demo",
    clearance: "INTERNAL",
    csrfToken: "csrf-value",
    authTime: new Date("2026-10-10T00:00:00Z"),
  };
  return {
    startLogin: async () => new URL("https://auth.example.com/authorize"),
    startReauthentication: async () => new URL("https://auth.example.com/authorize"),
    completeLogin: async () => ({ sessionCookieValue: "opaque-session-value", returnPath: "/", authTime: defaultUser.authTime }),
    getCurrentUser: async () => defaultUser,
    issueInternalUserToken: async () => "signed-internal-token",
    logout: async () => new URL("https://fieldloop-dev.kaotor.com/"),
    backchannelLogout: async () => {},
    jwks: async () => ({ keys: [] }),
    ...overrides,
  };
}

function sessionFixture(): AuthUser {
  const now = new Date("2026-10-10T00:00:00Z");
  return {
    userId: "user-id",
    orgId: "fieldloop-demo",
    sub: "synthetic-subject",
    displayName: "Synthetic Operator",
    sid: "keycloak-sid",
    roles: ["fieldloop.viewer"],
    clearance: "INTERNAL",
    csrfToken: "csrf-value",
    authTime: now,
    lastValidatedAt: new Date("2026-10-10T00:00:00Z"),
    lastActiveAt: now,
    accessExpiresAt: new Date("2026-10-10T00:10:00Z"),
    expiresAt: new Date("2026-10-10T12:00:00Z"),
    wrappedDataKey: Buffer.from("wrapped-key"),
    accessToken: Buffer.from("encrypted-access"),
    refreshToken: Buffer.from("encrypted-refresh"),
    idToken: Buffer.from("encrypted-id"),
  };
}

class TestAuthStore implements AuthStore {
  deletedSessions: string[] = [];
  deletedSids: string[] = [];
  transactions = new Map<string, OidcTransaction>();
  savedSession: Parameters<AuthStore["saveSession"]>[0] | undefined;
  validationMarks: Array<{ sessionHash: string; lastValidatedAt: Date }> = [];
  tokenUpdates: Array<Parameters<AuthStore["updateTokens"]>[0]> = [];
  constructor(private readonly session?: AuthUser) {}
  async createTransaction(transaction: OidcTransaction) { this.transactions.set(transaction.stateHash, transaction); }
  async consumeTransaction(stateHash: string) {
    const transaction = this.transactions.get(stateHash);
    this.transactions.delete(stateHash);
    return transaction;
  }
  async findSession() { return this.session; }
  get sessionForTest() { return this.session; }
  async markSessionValidated(sessionHash: string, lastValidatedAt: Date) {
    this.validationMarks.push({ sessionHash, lastValidatedAt });
    if (this.session) this.session.lastValidatedAt = lastValidatedAt;
  }
  async saveSession(input: Parameters<AuthStore["saveSession"]>[0]) { this.savedSession = input; }
  async touchSession() {}
  async updateTokens(input: Parameters<AuthStore["updateTokens"]>[0]) {
    this.tokenUpdates.push(input);
    if (this.session) {
      this.session.accessToken = input.accessToken;
      this.session.refreshToken = input.refreshToken;
      this.session.accessExpiresAt = input.accessExpiresAt;
      this.session.lastValidatedAt = input.lastValidatedAt;
    }
  }
  async deleteSession(sessionHash: string) { this.deletedSessions.push(sessionHash); }
  async deleteSessionsBySid(sid: string) { this.deletedSids.push(sid); }
}

function testCrypto(): EnvelopeCrypto {
  return {
    encryptNew: async (value) => ({ ciphertext: Buffer.from(`cipher:${Buffer.from(value).toString("base64")}`), wrappedDataKey: Buffer.from("wrapped-key") }),
    encryptWithKey: async (value) => Buffer.from(`cipher:${Buffer.from(value).toString("base64")}`),
    decryptWithKey: async (value) => {
      const plaintext = value.toString("utf8");
      if (plaintext.startsWith("cipher:")) return Buffer.from(plaintext.slice("cipher:".length), "base64").toString("utf8");
      return plaintext === "encrypted-access" ? "access-token" : plaintext;
    },
  };
}

function testOidc(overrides: Partial<OidcProvider> = {}): OidcProvider {
  return {
    authorizationUrl: async () => new URL("https://auth.example.com/authorize"),
    exchange: async () => { throw new Error("not used"); },
    introspect: async () => true,
    refresh: async () => { throw new Error("not used"); },
    endSessionUrl: async () => new URL("https://auth.example.com/logout"),
    verifyBackchannelLogout: async () => ({ sid: "keycloak-sid" }),
    ...overrides,
  };
}

function testInternalTokens(): InternalTokenService {
  return { sign: async () => "signed-token", jwks: async () => ({ keys: [] }) };
}

function createTestService(store: TestAuthStore, oidc: OidcProvider): BffAuthService {
  return new BffAuthService({
    store,
    crypto: testCrypto(),
    oidc,
    internalTokens: testInternalTokens(),
    baseUrl: "https://fieldloop-dev.kaotor.com",
    defaultOrgId: "fieldloop-demo",
    now: () => new Date("2026-10-10T00:02:00Z"),
  });
}

function transactionFixture(state: string): OidcTransaction {
  return {
    stateHash: hash(state),
    nonce: "test-nonce",
    encryptedCodeVerifier: Buffer.from(`cipher:${Buffer.from("test-verifier").toString("base64")}`),
    wrappedDataKey: Buffer.from("wrapped-key"),
    returnPath: "/map?domain=synthetic",
    reauthSessionHash: null,
    orgId: "fieldloop-demo",
    expiresAt: new Date("2026-10-10T00:12:00Z"),
  };
}

function tokenFixture(role: string, authTime: string | undefined = "2026-10-10T00:01:00Z"): LoginTokens {
  const claims: Record<string, unknown> = {
    sub: "synthetic-subject",
    name: "Synthetic User",
    sid: "keycloak-sid",
  };
  if (authTime) claims["auth_time"] = Math.floor(new Date(authTime).getTime() / 1000);
  return {
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    idToken: "id-secret",
    claims,
    accessClaims: {
      exp: Math.floor(Date.now() / 1000) + 300,
      clearance: "INTERNAL",
      resource_access: { "kaotor-fieldloop": { roles: [role] } },
    },
    expiresIn: 300,
  };
}
