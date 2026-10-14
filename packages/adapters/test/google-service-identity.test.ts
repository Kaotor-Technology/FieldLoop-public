import { generateKeyPairSync, sign } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { describe, expect, it, vi } from "vitest";
import { GoogleServiceIdentityVerifier } from "../src/google-service-identity.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const email = "push@fixture.iam.gserviceaccount.com";
const audience = "https://worker.example.test";
function fixture() {
  const client = new OAuth2Client();
  vi.spyOn(client, "getFederatedSignonCertsAsync").mockResolvedValue({ certs: { fixture: publicKey.export({ type: "spki", format: "pem" }).toString() }, format: 0 });
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: "https://accounts.google.com", sub: "fixture-service-id", aud: audience, iat: now, exp: now + 3600, email, email_verified: true };
  const token = (changes: Record<string, unknown> = {}) => {
    const body = [ { alg: "RS256", kid: "fixture" }, { ...claims, ...changes } ]
      .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
    return `${body}.${sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64url")}`;
  };
  return { verifier: new GoogleServiceIdentityVerifier(client), token, now };
}
describe("Google service identity cryptographic boundary", () => {
  it("accepts only the verified service identity", async () => {
    const { verifier, token } = fixture(); await expect(verifier.verify(token(), audience, email)).resolves.toBeUndefined();
  });
  it.each([{ aud: "wrong" }, { iss: "https://attacker.example.test" }, { email: "other@fixture.iam.gserviceaccount.com" }, { email_verified: false }, { sub: "" }, { exp: 1 }])("rejects invalid claims %j", async (claims) => {
    const { verifier, token } = fixture(); await expect(verifier.verify(token(claims), audience, email)).rejects.toThrow();
  });
  it("rejects an altered signature", async () => {
    const { verifier, token } = fixture(); const valid = token();
    const corrupted = valid.slice(0, valid.lastIndexOf(".") + 1) + Buffer.alloc(256).toString("base64url");
    await expect(verifier.verify(corrupted, audience, email)).rejects.toThrow();
  });
});
