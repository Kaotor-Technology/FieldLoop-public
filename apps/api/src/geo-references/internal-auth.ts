import { importJWK, jwtVerify, type JWK } from "jose";
import type { FastifyRequest } from "fastify";
import type { AuthServicePort } from "../auth/service.js";
import { GeoReferenceServiceError, type AssistantGeoIdentity } from "./model.js";

const INTERNAL_USER_HEADER = "x-fieldloop-internal-user-token";
const ALLOWED_ROLES = new Set(["fieldloop.viewer", "fieldloop.operator", "fieldloop.manager"]);
const CLASSIFICATIONS = new Set(["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED"]);

export async function assistantIdentityFromRequest(
  request: FastifyRequest,
  auth: AuthServicePort,
  issuer: string | undefined,
): Promise<AssistantGeoIdentity> {
  const authorization = request.headers.authorization;
  const customHeader = request.headers[INTERNAL_USER_HEADER];
  const bearer = typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
  if (Array.isArray(customHeader) || (bearer && typeof customHeader === "string" && bearer !== customHeader)) {
    throw new GeoReferenceServiceError(401, "unauthenticated");
  }
  const token = bearer ?? customHeader;
  if (!issuer || typeof token !== "string" || token.length < 16 || token.length > 8192 || token.trim() !== token) {
    throw new GeoReferenceServiceError(401, "unauthenticated");
  }

  let jwks: { keys: Record<string, unknown>[] };
  try {
    jwks = await auth.jwks();
  } catch {
    throw new GeoReferenceServiceError(503, "service_unavailable");
  }
  try {
    const { payload } = await jwtVerify(token, async (header) => {
      const jwk = jwks.keys.find((key) => key["kid"] === header.kid && key["kty"] === "RSA" && key["use"] === "sig");
      if (!jwk) throw new Error("Unknown internal signing key");
      return importJWK(jwk as JWK, "RS256");
    }, { issuer: new URL(issuer).origin, audience: "fieldloop-services", algorithms: ["RS256"], clockTolerance: 5 });

    const roles = payload["roles"];
    const clearance = payload["clearance"];
    const orgId = payload["org_id"];
    const issuedAt = payload["iat"];
    const expiresAt = payload["exp"];
    if (typeof payload.sub !== "string" || !payload.sub || typeof payload.jti !== "string" ||
        !Array.isArray(roles) || roles.length === 0 || !roles.every((role) => typeof role === "string" && ALLOWED_ROLES.has(role)) ||
        typeof orgId !== "string" || !orgId.trim() || typeof clearance !== "string" || !CLASSIFICATIONS.has(clearance) ||
        typeof issuedAt !== "number" || typeof expiresAt !== "number" || expiresAt <= issuedAt || expiresAt - issuedAt > 300) {
      throw new Error("Invalid internal identity claims");
    }
    return { sub: payload.sub, orgId, clearance, roles };
  } catch {
    throw new GeoReferenceServiceError(401, "unauthenticated");
  }
}
