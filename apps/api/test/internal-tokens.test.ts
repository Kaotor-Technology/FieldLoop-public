import { generateKeyPairSync } from "node:crypto";
import { importSPKI, jwtVerify } from "jose";
import { describe, expect, it, vi } from "vitest";
import type { AuthUser } from "../src/auth/model.js";
import { SecretManagerInternalTokenService } from "../src/auth/internal-tokens.js";
import type { SecretReader } from "../src/auth/secrets.js";

describe("internal user tokens", () => {
  it("signs a five-minute RS256 token with a public-only JWKS", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const read = vi.fn(async () => privateKey);
    const secrets: SecretReader = { read };
    const service = new SecretManagerInternalTokenService(secrets, "https://fieldloop-dev.kaotor.com", "fieldloop-services", "test-key");
    const user: AuthUser = {
      userId: "user-id",
      orgId: "fieldloop-demo",
      sub: "synthetic-subject",
      displayName: "Synthetic User",
      sid: "keycloak-sid",
      roles: ["fieldloop.operator"],
      clearance: "INTERNAL",
      csrfToken: "csrf-value",
      authTime: new Date("2026-10-10T00:00:00Z"),
      lastValidatedAt: new Date(),
      lastActiveAt: new Date(),
      accessExpiresAt: new Date(Date.now() + 60_000),
      expiresAt: new Date(Date.now() + 60_000),
      wrappedDataKey: Buffer.from("wrapped-key"),
      accessToken: Buffer.from("encrypted-access"),
      refreshToken: Buffer.from("encrypted-refresh"),
      idToken: Buffer.from("encrypted-id"),
    };

    const token = await service.sign(user);
    const verificationKey = await importSPKI(publicKey, "RS256");
    const { payload, protectedHeader } = await jwtVerify(token, verificationKey, {
      issuer: "https://fieldloop-dev.kaotor.com",
      audience: "fieldloop-services",
      algorithms: ["RS256"],
    });
    const jwks = await service.jwks();
    const jwk = jwks.keys[0];

    expect(payload).toMatchObject({
      sub: "synthetic-subject",
      roles: ["fieldloop.operator"],
      clearance: "INTERNAL",
      org_id: "fieldloop-demo",
    });
    expect(Number(payload["exp"]) - Number(payload["iat"])).toBe(300);
    expect(protectedHeader).toMatchObject({ alg: "RS256", kid: "test-key" });
    expect(jwk).toMatchObject({ kty: "RSA", kid: "test-key", use: "sig", alg: "RS256" });
    expect(jwk).not.toHaveProperty("d");
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith("fieldloop-v2-internal-token-signing");
  });

  it("verifies only its own unexpired tokens for this issuer and audience", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const other = generateKeyPairSync("rsa", {
      modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const make = (pem: string, issuer: string, audience: string) =>
      new SecretManagerInternalTokenService({ read: async () => pem }, issuer, audience, "k");
    const issuer = "https://fieldloop-dev.kaotor.com";
    const service = make(privateKey, issuer, "fieldloop-services");
    const user = {
      userId: "u", orgId: "fieldloop-demo", sub: "synthetic-subject", displayName: null, sid: null,
      roles: ["fieldloop.operator"], clearance: "INTERNAL", csrfToken: "c", authTime: new Date(),
      lastValidatedAt: new Date(), lastActiveAt: new Date(), accessExpiresAt: new Date(),
      expiresAt: new Date(), wrappedDataKey: Buffer.from("k"), accessToken: Buffer.from("a"),
      refreshToken: null, idToken: Buffer.from("i"),
    } satisfies AuthUser;

    const token = await service.sign(user);
    expect(await service.verify(token)).toEqual({
      sub: "synthetic-subject", roles: ["fieldloop.operator"], clearance: "INTERNAL", orgId: "fieldloop-demo",
    });
    // Signed by another key, minted for another audience or issuer, or not a token at all.
    await expect(service.verify(await make(other.privateKey, issuer, "fieldloop-services").sign(user))).rejects.toThrow();
    await expect(service.verify(await make(privateKey, issuer, "other-audience").sign(user))).rejects.toThrow();
    await expect(service.verify(await make(privateKey, "https://evil.example", "fieldloop-services").sign(user))).rejects.toThrow();
    await expect(service.verify("not-a-token")).rejects.toThrow();
  });
});
