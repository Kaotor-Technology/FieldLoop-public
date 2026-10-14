import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";
import type { GuardrailClassification } from "@fieldloop/adapters";

const allowedRoles = new Set(["fieldloop.viewer", "fieldloop.operator", "fieldloop.manager"]);

export interface InternalUserIdentity {
  sub: string;
  roles: string[];
  clearance: GuardrailClassification;
  orgId: string;
}

export interface InternalUserTokenVerifier {
  verify(token: string): Promise<InternalUserIdentity>;
}

export class InvalidInternalUserTokenError extends Error {
  constructor() {
    super("Internal user token is invalid");
    this.name = "InvalidInternalUserTokenError";
  }
}

export class InternalUserTokenVerifierUnavailableError extends Error {
  constructor() {
    super("Internal user token verification is unavailable");
    this.name = "InternalUserTokenVerifierUnavailableError";
  }
}

export class RemoteInternalUserTokenVerifier implements InternalUserTokenVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly options: { jwksUrl: string; issuer: string; audience: string }) {
    const jwksUrl = new URL(options.jwksUrl);
    if (jwksUrl.protocol !== "https:" && !(jwksUrl.protocol === "http:" && isLoopback(jwksUrl.hostname))) {
      throw new Error("Internal token JWKS URL must use HTTPS");
    }
    if (!options.issuer || !options.audience) throw new Error("Internal token issuer and audience are required");
    this.jwks = createRemoteJWKSet(jwksUrl, { timeoutDuration: 3_000, cooldownDuration: 30_000, cacheMaxAge: 300_000 });
  }

  async verify(token: string): Promise<InternalUserIdentity> {
    let payload: Record<string, unknown>;
    try {
      const result = await jwtVerify(token, this.jwks, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: ["RS256"],
        maxTokenAge: "5m",
        clockTolerance: 5,
      });
      payload = result.payload;
    } catch (error) {
      if (error instanceof joseErrors.JWKSTimeout || error instanceof joseErrors.JWKSInvalid) {
        throw new InternalUserTokenVerifierUnavailableError();
      }
      if (error instanceof joseErrors.JOSEError) throw new InvalidInternalUserTokenError();
      throw new InternalUserTokenVerifierUnavailableError();
    }

    const subject = payload["sub"];
    const roles = payload["roles"];
    const clearance = payload["clearance"];
    const orgId = payload["org_id"];
    if (typeof subject !== "string" || subject.length === 0 || typeof orgId !== "string" || orgId.length === 0
      || typeof payload["jti"] !== "string" || payload["jti"].length === 0
      || !Array.isArray(roles) || roles.length === 0
      || roles.some((role) => typeof role !== "string" || !allowedRoles.has(role))
      || !isClassification(clearance)) {
      throw new InvalidInternalUserTokenError();
    }
    return { sub: subject, roles, clearance, orgId };
  }
}

function isClassification(value: unknown): value is GuardrailClassification {
  return value === "PUBLIC" || value === "INTERNAL" || value === "CONFIDENTIAL" || value === "HIGHLY_RESTRICTED";
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
