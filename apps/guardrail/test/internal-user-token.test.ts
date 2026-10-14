import { createServer, type Server } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportJWK, SignJWT } from "jose";
import { InvalidInternalUserTokenError, RemoteInternalUserTokenVerifier } from "../src/internal-user-token.js";

const issuer = "https://fieldloop.test";
const audience = "fieldloop-services";
const keyId = "guardrail-test-key";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 0x10001 });
const server: Server = createServer(async (request, response) => {
  if (request.url !== "/jwks") {
    response.writeHead(404).end();
    return;
  }
  const jwk = await exportJWK(publicKey);
  response.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=300" });
  response.end(JSON.stringify({ keys: [{ ...jwk, kid: keyId, use: "sig", alg: "RS256" }] }));
});

let verifier: RemoteInternalUserTokenVerifier;
let jwksUrl = "";

beforeAll(async () => {
  const port = await listen(server);
  jwksUrl = `http://127.0.0.1:${port}/jwks`;
  verifier = new RemoteInternalUserTokenVerifier({ jwksUrl, issuer, audience });
});

afterAll(async () => close(server));

describe("RemoteInternalUserTokenVerifier", () => {
  it("verifies the RS256 signature, issuer, audience, five-minute age and identity claims", async () => {
    const token = await signToken();

    await expect(verifier.verify(token)).resolves.toEqual({
      sub: "synthetic-reviewer",
      roles: ["fieldloop.viewer"],
      clearance: "INTERNAL",
      orgId: "fieldloop-demo",
    });
  });

  it("rejects a wrong issuer, audience, stale token and invalid identity claims", async () => {
    const wrongIssuer = await signToken({ issuer: "https://attacker.test" });
    const wrongAudience = await signToken({ audience: "another-service" });
    const stale = await signToken({ issuedAt: Math.floor(Date.now() / 1000) - 600 });
    const invalidRole = await signToken({ roles: ["fieldloop.admin"] });

    await expect(verifier.verify(wrongIssuer)).rejects.toBeInstanceOf(InvalidInternalUserTokenError);
    await expect(verifier.verify(wrongAudience)).rejects.toBeInstanceOf(InvalidInternalUserTokenError);
    await expect(verifier.verify(stale)).rejects.toBeInstanceOf(InvalidInternalUserTokenError);
    await expect(verifier.verify(invalidRole)).rejects.toBeInstanceOf(InvalidInternalUserTokenError);
  });

  it("requires HTTPS for a non-loopback JWKS URL", () => {
    expect(() => new RemoteInternalUserTokenVerifier({ jwksUrl: "http://example.test/jwks", issuer, audience }))
      .toThrow("Internal token JWKS URL must use HTTPS");
  });
});

async function signToken(options: {
  issuer?: string;
  audience?: string;
  issuedAt?: number;
  roles?: string[];
  sub?: string;
} = {}): Promise<string> {
  const issuedAt = options.issuedAt ?? Math.floor(Date.now() / 1000);
  return new SignJWT({ roles: options.roles ?? ["fieldloop.viewer"], clearance: "INTERNAL", org_id: "fieldloop-demo" })
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: keyId })
    .setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? audience)
    .setSubject(options.sub ?? "synthetic-reviewer")
    .setJti("synthetic-test-token")
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 300)
    .sign(privateKey);
}

function listen(target: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", () => {
      const address = target.address();
      if (!address || typeof address === "string") {
        reject(new Error("Test JWKS server has no TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(target: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    target.close((error) => error ? reject(error) : resolve());
  });
}
