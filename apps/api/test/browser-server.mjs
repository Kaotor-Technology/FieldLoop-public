// Local-only browser fixture: real BFF service/routes/crypto with in-memory persistence and a scripted IdP.
import { createServer } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { buildApp } from "../dist/app.js";
import { registerSpa } from "../dist/spa.js";
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
        accessClaims: { exp: Math.floor(Date.now() / 1000) + 300, resource_access: { "kaotor-fieldloop": { roles: [`fieldloop.${role}`] } } },
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
const app = buildApp({ auth, baseUrl });
await registerSpa(app, fileURLToPath(new URL("../../web/dist/", import.meta.url)));
await app.ready();

export const directory = await mkdtemp(join(tmpdir(), "fieldloop-browser-tls-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem")], { stdio: "ignore" });
const server = createServer({ key: await readFile(join(directory, "key.pem")), cert: await readFile(join(directory, "cert.pem")) }, async (request, response) => {
  try {
    const url = new URL(request.url, baseUrl);
    if (url.pathname === "/test/reset") {
      sessions.clear(); transactions.clear(); authorizations.clear(); codes.clear(); now = Date.now(); active = true; unavailable = false;
      response.end("reset"); return;
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
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const result = await app.inject({ method: request.method, url: request.url, headers: request.headers, payload: Buffer.concat(chunks) });
    response.writeHead(result.statusCode, result.headers); response.end(result.rawPayload);
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
