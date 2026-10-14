// Local-only browser fixture: real BFF service/routes/crypto with in-memory persistence and a scripted IdP.
import { createServer } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { simulator, resetSimulationFixture } from "./simulation-fixture.mjs";
import { buildApp } from "../dist/app.js";
import { registerSpa } from "../dist/spa.js";
import { registerReference } from "../dist/reference.js";
import { BffAuthService, hash } from "../dist/auth/service.js";
import { KmsEnvelopeCrypto } from "../dist/auth/envelope-crypto.js";

const baseUrl = process.env["FIELDLOOP_BROWSER_BASE_URL"] ?? "https://localhost:4173";
const sessions = new Map();
const transactions = new Map();
const authorizations = new Map();
const codes = new Map();
let now = Date.now();
let active = true;
let unavailable = false;
const emptyEventId = "00000000-0000-0000-0000-000000000000";
const seedHealthProposals = () => [
  { id: "00000000-0000-4000-8000-000000000083", barrierId: "00000000-0000-4000-8000-000000000183", barrierName: "SYNTHETIC-CP-01", currentHealth: "healthy", proposedHealth: "degraded", sourceReason: "SIMULATION rectifier reading is below the registered threshold", simulated: true, createdAt: "2026-10-14T00:00:00.000Z", status: "open", ownerSub: "synthetic-operator" },
  { id: "00000000-0000-4000-8000-000000000084", barrierId: "00000000-0000-4000-8000-000000000184", barrierName: "SYNTHETIC-CP-02", currentHealth: "healthy", proposedHealth: "failed", sourceReason: "SIMULATION inspection signal requires owner review", simulated: true, createdAt: "2026-10-14T00:01:00.000Z", status: "open", ownerSub: "synthetic-operator" },
];
let healthProposals = seedHealthProposals();
let healthDecisions = [];
let healthEvents = [];
let healthEventTime = new Date();
const health = {
  listProposals: async (user, cursor, limit) => {
    const open = healthProposals.filter((proposal) => proposal.status === "open" && proposal.ownerSub === user.sub).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const items = cursor ? [] : open.slice(0, limit).map((proposal) => ({
      id: proposal.id, barrierId: proposal.barrierId, barrierName: proposal.barrierName,
      currentHealth: proposal.currentHealth, proposedHealth: proposal.proposedHealth,
      sourceReason: proposal.sourceReason, simulated: proposal.simulated, createdAt: proposal.createdAt,
    }));
    return { items, limit, nextCursor: open.length > limit ? "fixture-next-cursor" : null };
  },
  decide: async ({ user, proposalId, decision, reason }) => {
    const proposal = healthProposals.find((item) => item.id === proposalId);
    if (!proposal || proposal.status !== "open" || user.sub !== proposal.ownerSub) throw new Error("Fixture proposal is unavailable");
    proposal.status = decision === "accept" ? "accepted" : "rejected";
    healthDecisions.push({ proposalId, decision, reason });
    const currentHealth = decision === "accept" ? proposal.proposedHealth : proposal.currentHealth;
    if (decision === "accept") {
      healthEventTime = new Date(Math.max(Date.now(), healthEventTime.getTime() + 1));
      const event = { id: randomUUID(), type: "barrier.health_changed", orgId: user.orgId,
        entityId: randomUUID(), barrierId: proposal.barrierId, simulated: true, classification: "CONFIDENTIAL", health: currentHealth };
      const position = { createdAt: healthEventTime.toISOString(), id: event.id };
      healthEvents.push({ position, event });
    }
    return { healthProposalId: proposal.id, status: proposal.status, barrierId: proposal.barrierId, health: currentHealth };
  },
  listNotifications: async (_user, _cursor, limit) => ({ items: [], limit, nextCursor: null }),
  latestEventPosition: async () => ({ createdAt: healthEventTime.toISOString(), id: healthEvents.at(-1)?.position.id ?? emptyEventId }),
  listEvents: async (_user, after, limit) => healthEvents.filter(({ position }) => !after
    || position.createdAt > after.createdAt || (position.createdAt === after.createdAt && position.id > after.id)).slice(0, limit),
};
function resetHealthFixture() {
  healthProposals = seedHealthProposals();
  healthDecisions = [];
  healthEvents = [];
  healthEventTime = new Date();
}
const store = {
  createTransaction: async (transaction) => { transactions.set(transaction.stateHash, transaction); },
  consumeTransaction: async (key) => { const value = transactions.get(key); transactions.delete(key); return value; },
  findSession: async (key) => sessions.get(key),
  saveSession: async (input) => { sessions.set(input.sessionHash, { ...input, userId: input.sub }); },
  markSessionValidated: async (key, time) => { sessions.get(key).lastValidatedAt = time; },
  touchSession: async (key, time) => { sessions.get(key).lastActiveAt = time; },
  updateTokens: async (input) => { Object.assign(sessions.get(input.sessionHash), input); },
  deleteSession: async (key) => { sessions.delete(key); },
  deleteSessionsBySid: async (sid) => { for (const [key, value] of sessions) if (value.sid === sid) sessions.delete(key); },
};
const auth = new BffAuthService({
  store, baseUrl, defaultOrgId: "synthetic-org", now: () => new Date(now),
  crypto: new KmsEnvelopeCrypto({
    wrapKey: async (key) => Buffer.from(key.toString("base64")),
    unwrapKey: async (key) => Buffer.from(key.toString(), "base64"),
  }),
  internalTokens: { sign: async () => { throw new Error("Internal token issuance is outside this fixture"); }, jwks: async () => ({ keys: [] }) },
  oidc: {
    authorizationUrl: async (input) => {
      authorizations.set(input.state, input);
      return new URL(`/test/sso?state=${input.state}`, baseUrl);
    },
    exchange: async (input) => {
      const code = input.callbackUrl.searchParams.get("code");
      const authorization = authorizations.get(input.state);
      const grant = codes.get(code);
      const role = grant?.role;
      codes.delete(code);
      authorizations.delete(input.state);
      const challenge = Buffer.from(hash(input.codeVerifier), "hex").toString("base64url");
      if (!role || grant.state !== input.state || !authorization || authorization.nonce !== input.nonce || authorization.codeChallenge !== challenge) throw new Error("Invalid scripted grant");
      return {
        accessToken: "server-only-access-token", refreshToken: "server-only-refresh-token", idToken: "server-only-id-token", expiresIn: 300,
        claims: { sub: `synthetic-${role}`, sid: `synthetic-sid-${role}`, auth_time: Math.floor(now / 1000) },
        accessClaims: { clearance: "HIGHLY_RESTRICTED", exp: Math.floor(Date.now() / 1000) + 300, resource_access: { "kaotor-fieldloop": { roles: [`fieldloop.${role}`] } } },
      };
    },
    introspect: async () => { if (unavailable) throw new Error("Scripted IdP unavailable"); return active; },
    refresh: async () => { throw new Error("Refresh is outside these browser cases"); },
    endSessionUrl: async (_token, returnUrl) => new URL(`/test/logout?return=${encodeURIComponent(returnUrl)}`, baseUrl),
    verifyBackchannelLogout: async (token) => {
      if (!token.startsWith("fixture-signed:")) throw new Error("Invalid scripted logout");
      return { sid: token.slice("fixture-signed:".length) };
    },
  },
});
const app = buildApp({ auth, baseUrl, simulator, health });
await registerReference(app, fileURLToPath(new URL("reference/", import.meta.resolve("@fieldloop/contracts"))));
await registerSpa(app, fileURLToPath(new URL("../../web/dist/", import.meta.url)));
await app.ready();

export const directory = await mkdtemp(join(tmpdir(), "fieldloop-browser-tls-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem")], { stdio: "ignore" });
const server = createServer({ key: await readFile(join(directory, "key.pem")), cert: await readFile(join(directory, "cert.pem")) }, async (request, response) => {
  try {
    const url = new URL(request.url, baseUrl);
    if (url.pathname === "/test/reset") {
      resetSimulationFixture(); resetHealthFixture();
      sessions.clear(); transactions.clear(); authorizations.clear(); codes.clear(); now = Date.now(); active = true; unavailable = false;
      response.end("reset"); return;
    }
    if (url.pathname === "/test/health-state") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ decisions: healthDecisions, eventCount: healthEvents.length })); return;
    }
    if (url.pathname === "/test/health-owner") {
      const ownerSub = url.searchParams.get("sub");
      if (!ownerSub) { response.writeHead(400); response.end("Missing owner"); return; }
      healthProposals.forEach((proposal) => { proposal.ownerSub = ownerSub; });
      response.end("updated"); return;
    }
    if (url.pathname === "/test/status") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ sessions: sessions.size })); return; }
    if (url.pathname === "/test/revoke") { active = false; now += 61_000; response.end("revoked"); return; }
    if (url.pathname === "/test/unavailable") { unavailable = url.searchParams.get("enabled") === "true"; now += 61_000; response.end("updated"); return; }
    if (url.pathname === "/test/sso") {
      const state = url.searchParams.get("state");
      const role = url.searchParams.get("role");
      if (!authorizations.has(state)) { response.writeHead(400); response.end("Unknown state"); return; }
      if (["viewer", "operator", "manager"].includes(role)) {
        const code = randomBytes(24).toString("base64url"); codes.set(code, { role, state });
        response.writeHead(302, { location: `/api/auth/callback?${new URLSearchParams({ state, code })}` }); response.end(); return;
      }
      response.setHeader("content-type", "text/html");
      response.end(`<html lang="en"><title>Scripted SSO</title><body><h1>Scripted SSO</h1>${["viewer", "operator", "manager"].map((value) => `<a href="/test/sso?${new URLSearchParams({ state, role: value })}">Sign in as ${value}</a>`).join(" ")}</body></html>`); return;
    }
    if (url.pathname === "/test/logout") {
      response.setHeader("content-type", "text/html");
      response.end('<html lang="en"><title>Confirm logout</title><body><h1>Confirm SSO logout</h1><a href="/">Confirm logout</a></body></html>'); return;
    }
    // Route the HTTPS request directly so SSE reaches the browser incrementally.
    app.server.emit("request", request, response);
  } catch { response.writeHead(500); response.end("Browser fixture failed"); }
});
server.listen(4173, "localhost");
let closing;
export function closeBrowserServer() {
  return closing ??= (async () => {
    try {
      await new Promise((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve(); });
        server.closeAllConnections();
      });
      await app.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  })();
}
// An importing dev harness owns shutdown and awaits cleanup before Vite exits.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => {
    await closeBrowserServer();
  });
}
