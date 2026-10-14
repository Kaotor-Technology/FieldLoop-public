import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { AuthError, type AuthServicePort, type CurrentUser } from "../src/auth/service.js";
import { RiskServiceError, type RiskApiPort } from "../src/risk/service.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function fixture(riskOverrides: Partial<RiskApiPort> = {}) {
  const user: CurrentUser = {
    sub: "synthetic-reviewer", roles: ["fieldloop.viewer"], persona: "Executive",
    orgId: "synthetic-org", clearance: "INTERNAL", csrfToken: "fixture-csrf", authTime: new Date("2026-10-13T00:00:00Z"),
  };
  const auth: AuthServicePort = {
    getCurrentUser: async (cookie) => {
      if (cookie !== "valid") throw new AuthError("Session required", 401);
      return user;
    },
    startLogin: async () => new URL("https://example.test"),
    startReauthentication: async () => new URL("https://example.test"),
    completeLogin: async () => { throw new Error("unused"); },
    issueInternalUserToken: async () => { throw new Error("unused"); },
    logout: async () => new URL("https://example.test"),
    backchannelLogout: async () => {},
    jwks: async () => ({ keys: [] }),
  };
  let receivedOrgId = "";
  const risk: RiskApiPort = {
    listBowties: async (currentUser) => { receivedOrgId = currentUser.orgId; return []; },
    getBowtie: async () => { throw new RiskServiceError(404, "not_found"); },
    getRisk: async () => { throw new RiskServiceError(409, "risk_matrix_unconfigured"); },
    explain: async () => { throw new RiskServiceError(409, "risk_matrix_unconfigured"); },
    getEvidence: async () => { throw new RiskServiceError(404, "not_found"); },
    riskEventsAfter: async () => [],
    processHealthChanges: async () => 0,
    ...riskOverrides,
  };
  const app = buildApp({ auth, risk });
  apps.push(app);
  return { app, user, headers: { cookie: "fl_session=valid" }, get receivedOrgId() { return receivedOrgId; } };
}

describe("risk API routes", () => {
  it("requires a session and passes the session Organisation to the service", async () => {
    const testFixture = fixture();
    const { app, headers } = testFixture;
    expect((await app.inject({ method: "GET", url: "/api/v1/bowties" })).statusCode).toBe(401);

    const response = await app.inject({ method: "GET", url: "/api/v1/bowties", headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
    expect(testFixture.receivedOrgId).toBe("synthetic-org");
  });

  it("returns a typed fail-closed problem when the Organisation has no approved calibration", async () => {
    const { app, headers } = fixture();
    const response = await app.inject({
      method: "GET", url: "/api/v1/bowties/19b46b91-1cec-4502-96da-7d6ec03af16e/risk", headers,
    });

    expect(response.statusCode).toBe(409);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({
      status: 409, code: "risk_matrix_unconfigured", title: "Organisation Risk Matrix is not approved",
    });
  });

  it.each([
    { internalCode: "clearance_denied", status: 403, publicCode: "forbidden" },
    { internalCode: "risk_snapshot_unavailable", status: 503, publicCode: "risk_service_unavailable" },
  ])("maps internal $internalCode errors to the OpenAPI code $publicCode", async ({ internalCode, status, publicCode }) => {
    const { app, headers } = fixture({
      getBowtie: async () => { throw new RiskServiceError(status, internalCode); },
    });
    const response = await app.inject({ method: "GET", url: "/api/v1/bowties/19b46b91-1cec-4502-96da-7d6ec03af16e", headers });

    expect(response.statusCode).toBe(status);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json().code).toBe(publicCode);
  });

  it("rejects malformed Bowtie IDs before calling the service", async () => {
    const { app, headers } = fixture();
    const response = await app.inject({ method: "GET", url: "/api/v1/bowties/not-a-uuid/risk", headers });

    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json().code).toBe("validation_failed");
  });
});
