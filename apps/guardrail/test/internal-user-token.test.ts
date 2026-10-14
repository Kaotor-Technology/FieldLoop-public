import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { exportJWK, SignJWT } from "jose";
import { InvalidInternalUserTokenError, LocalJwksInternalUserTokenVerifier } from "../src/internal-user-token.js";

const issuer = "https://fieldloop.test";
const audience = "fieldloop-services";
const keyId = "guardrail-test-key";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 0x10001 });

let jwks = "";
let verifier: LocalJwksInternalUserTokenVerifier;

beforeAll(async () => {
  const jwk = await exportJWK(publicKey);
  jwks = JSON.stringify({ keys: [{ ...jwk, kid: keyId, use: "sig", alg: "RS256" }] });
  verifier = new LocalJwksInternalUserTokenVerifier({ jwks, issuer, audience });
});

describe("LocalJwksInternalUserTokenVerifier", () => {
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

  it("rejects a token signed by a key that is not in the configured JWKS", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 0x10001 });
    const foreign = await signToken({ key: other.privateKey });

    await expect(verifier.verify(foreign)).rejects.toBeInstanceOf(InvalidInternalUserTokenError);
  });

  it("refuses a malformed, empty or private-key JWKS at construction", async () => {
    const privateJwk = await exportJWK(privateKey);

    expect(() => new LocalJwksInternalUserTokenVerifier({ jwks: "not json", issuer, audience }))
      .toThrow("Internal token JWKS must be a JSON key set");
    expect(() => new LocalJwksInternalUserTokenVerifier({ jwks: JSON.stringify({ keys: [] }), issuer, audience }))
      .toThrow("Internal token JWKS must contain RSA public keys only");
    expect(() => new LocalJwksInternalUserTokenVerifier({ jwks: JSON.stringify({ keys: [{ ...privateJwk, kid: keyId }] }), issuer, audience }))
      .toThrow("Internal token JWKS must contain RSA public keys only");
  });
});

async function signToken(options: {
  issuer?: string;
  audience?: string;
  issuedAt?: number;
  roles?: string[];
  sub?: string;
  key?: typeof privateKey;
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
    .sign(options.key ?? privateKey);
}
