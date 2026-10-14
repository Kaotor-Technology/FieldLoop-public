import { createLocalJWKSet, errors as joseErrors, jwtVerify, type JSONWebKeySet } from "jose";
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

// The public key set is configuration, so verification needs no call to web-api (which stays private).
export class LocalJwksInternalUserTokenVerifier implements InternalUserTokenVerifier {
  private readonly jwks: ReturnType<typeof createLocalJWKSet>;

  constructor(private readonly options: { jwks: string; issuer: string; audience: string }) {
    if (!options.issuer || !options.audience) throw new Error("Internal token issuer and audience are required");
    this.jwks = createLocalJWKSet(parsePublicKeySet(options.jwks));
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

function parsePublicKeySet(value: string): JSONWebKeySet {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Internal token JWKS must be a JSON key set");
  }
  const keys = typeof parsed === "object" && parsed !== null ? (parsed as { keys?: unknown }).keys : undefined;
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every(isRsaPublicKey)) {
    throw new Error("Internal token JWKS must contain RSA public keys only");
  }
  return { keys };
}

function isRsaPublicKey(key: unknown): key is JSONWebKeySet["keys"][number] {
  if (typeof key !== "object" || key === null) return false;
  const jwk = key as Record<string, unknown>;
  return jwk["kty"] === "RSA" && typeof jwk["n"] === "string" && typeof jwk["e"] === "string" && !("d" in jwk);
}

function isClassification(value: unknown): value is GuardrailClassification {
  return value === "PUBLIC" || value === "INTERNAL" || value === "CONFIDENTIAL" || value === "HIGHLY_RESTRICTED";
}
