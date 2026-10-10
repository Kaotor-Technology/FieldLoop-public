import { createPublicKey, randomUUID } from "node:crypto";
import { exportJWK, importJWK, importPKCS8, SignJWT, type JWK } from "jose";
import type { AuthUser, InternalTokenService } from "./model.js";
import type { SecretReader } from "./secrets.js";

export class SecretManagerInternalTokenService implements InternalTokenService {
  private keyPairPromise: Promise<{
    privateKey: Awaited<ReturnType<typeof importPKCS8>>;
    publicKey: Awaited<ReturnType<typeof importJWK>>;
    jwk: JWK;
  }> | undefined;

  constructor(
    private readonly secrets: SecretReader,
    private readonly issuer: string,
    private readonly audience: string,
    private readonly kid: string,
  ) {}

  async sign(user: AuthUser): Promise<string> {
    const { privateKey } = await this.keyPair();
    const issuedAt = Math.floor(Date.now() / 1000);
    return new SignJWT({ roles: user.roles, clearance: user.clearance, org_id: user.orgId })
      .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: this.kid })
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setSubject(user.sub)
      .setJti(randomUUID())
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 300)
      .sign(privateKey);
  }

  async jwks(): Promise<{ keys: Record<string, unknown>[] }> {
    const { jwk } = await this.keyPair();
    return { keys: [{ ...jwk, kid: this.kid, use: "sig", alg: "RS256" }] };
  }

  private async keyPair(): Promise<{
    privateKey: Awaited<ReturnType<typeof importPKCS8>>;
    publicKey: Awaited<ReturnType<typeof importJWK>>;
    jwk: JWK;
  }> {
    this.keyPairPromise ??= (async () => {
      const pem = await this.secrets.read("fieldloop-v2-internal-token-signing");
      const privateKey = await importPKCS8(pem, "RS256");
      const publicJwk = createPublicKey(pem).export({ format: "jwk" });
      if (!publicJwk.kty || !publicJwk.n || !publicJwk.e) throw new Error("Internal signing secret must be an RSA private key");
      const publicKey = await importJWK({ kty: publicJwk.kty, n: publicJwk.n, e: publicJwk.e }, "RS256");
      const jwk = await exportJWK(publicKey);
      return { privateKey, publicKey, jwk };
    })();
    try {
      return await this.keyPairPromise;
    } catch (error) {
      this.keyPairPromise = undefined;
      throw error;
    }
  }
}
