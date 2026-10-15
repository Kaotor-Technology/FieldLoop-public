import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { assistantIdentityFromRequest } from "./internal-auth.js";
import {
  GeoReferenceServiceError,
  type GeoReferenceCandidate,
  type GeoReferenceStore,
} from "./model.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
const CANDIDATE_KEYS = new Set([
  "latitude", "longitude", "chainageFrom", "chainageTo", "assetCode", "placeName", "sourceSnippet", "confidence",
]);
const INTERNAL_PATHS = new Set([
  "GET /api/internal/assistant/documents/:documentId/geo-source",
  "POST /api/internal/assistant/documents/:documentId/geo-references",
]);

export function registerGeoReferenceRoutes(
  app: FastifyInstance,
  store: GeoReferenceStore | undefined,
  baseUrl: string | undefined,
): void {
  app.register(async (routes) => {
    routes.setErrorHandler((error: unknown, request, reply) => {
      if (error instanceof GeoReferenceServiceError) return sendProblem(request, reply, error.status, error.code);
      const frameworkStatus = (error as { statusCode?: number } | null)?.statusCode;
      if (frameworkStatus && frameworkStatus >= 400 && frameworkStatus < 500) {
        return sendProblem(request, reply, frameworkStatus === 413 ? 413 : 400,
          frameworkStatus === 413 ? "payload_too_large" : "validation_failed");
      }
      request.log.error({ errorType: error instanceof Error ? error.name : "unknown" }, "Geo Reference request failed");
      return sendProblem(request, reply, 503, "service_unavailable");
    });

    const service = () => {
      if (!store) throw new GeoReferenceServiceError(503, "service_unavailable");
      return store;
    };

    routes.get("/api/v1/geo-references", async (request, reply) => {
      const query = request.query as Record<string, unknown>;
      const cursor = query["cursor"];
      const rawLimit = query["limit"];
      const limit = rawLimit === undefined ? 50 : typeof rawLimit === "string" && /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : Number.NaN;
      if (query["status"] !== "draft" || (cursor !== undefined && (typeof cursor !== "string" || cursor.length < 1 || cursor.length > 512)) ||
          !Number.isInteger(limit) || limit < 1 || limit > 200 ||
          Object.keys(query).some((key) => !["status", "cursor", "limit"].includes(key))) {
        throw new GeoReferenceServiceError(400, "validation_failed");
      }
      const user = request.fieldLoopCurrentUser;
      if (!user) throw new GeoReferenceServiceError(401, "unauthenticated");
      const page = await service().listDrafts(user, typeof cursor === "string" ? cursor : undefined, limit);
      return reply.header("cache-control", "private, no-store").send(page);
    });

    routes.post("/api/v1/geo-references/:geoReferenceId([0-9a-fA-F-]{36})::confirm", async (request, reply) => {
      const user = requireDecisionUser(request);
      const geoReferenceId = (request.params as { geoReferenceId: string }).geoReferenceId;
      const body = request.body === undefined ? {} : request.body;
      if (!isRecord(body) || Object.keys(body).some((key) => key !== "targetAssetId") ||
          (body["targetAssetId"] !== undefined && (typeof body["targetAssetId"] !== "string" || !UUID_PATTERN.test(body["targetAssetId"])))) {
        throw new GeoReferenceServiceError(400, "validation_failed");
      }
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
        throw new GeoReferenceServiceError(400, "validation_failed");
      }
      const item = await service().decide({
        scope: user,
        geoReferenceId,
        decision: "confirm",
        ...(typeof body["targetAssetId"] === "string" ? { targetAssetId: body["targetAssetId"] } : {}),
        idempotencyKey,
      });
      return reply.header("cache-control", "private, no-store").send(item);
    });

    routes.post("/api/v1/geo-references/:geoReferenceId([0-9a-fA-F-]{36})::reject", async (request, reply) => {
      const user = requireDecisionUser(request);
      const geoReferenceId = (request.params as { geoReferenceId: string }).geoReferenceId;
      if (request.body !== undefined && request.body !== null) throw new GeoReferenceServiceError(400, "validation_failed");
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
        throw new GeoReferenceServiceError(400, "validation_failed");
      }
      const item = await service().decide({ scope: user, geoReferenceId, decision: "reject", idempotencyKey });
      return reply.header("cache-control", "private, no-store").send(item);
    });

    routes.get("/api/internal/assistant/documents/:documentId/geo-source", async (request, reply) => {
      const identity = await assistantIdentityFromRequest(request, app.fieldLoopAuth, baseUrl);
      const documentId = (request.params as { documentId: string }).documentId;
      const source = await service().getSource(documentId, identity);
      return reply.header("cache-control", "private, no-store").send(source);
    });

    routes.post("/api/internal/assistant/documents/:documentId/geo-references", async (request, reply) => {
      const identity = await assistantIdentityFromRequest(request, app.fieldLoopAuth, baseUrl);
      const documentId = (request.params as { documentId: string }).documentId;
      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
        throw new GeoReferenceServiceError(400, "validation_failed");
      }
      const body = parseCreateBody(request.body);
      const result = await service().createDrafts({ documentId, scope: identity, idempotencyKey, references: body.references });
      return reply.header("cache-control", "private, no-store").code(201).send(result);
    });
  });
}

export function isAssistantInternalPath(method: string, routePattern: string | undefined): boolean {
  return INTERNAL_PATHS.has(`${method} ${routePattern ?? ""}`);
}

function requireDecisionUser(request: FastifyRequest) {
  const user = request.fieldLoopCurrentUser;
  if (!user) throw new GeoReferenceServiceError(401, "unauthenticated");
  if (!user.roles.some((role) => role === "fieldloop.operator" || role === "fieldloop.manager")) {
    throw new GeoReferenceServiceError(403, "forbidden");
  }
  return user;
}

function parseCreateBody(value: unknown): { references: GeoReferenceCandidate[] } {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "references") ||
      !Array.isArray(value["references"]) || value["references"].length > 50) {
    throw new GeoReferenceServiceError(400, "validation_failed");
  }
  const references = value["references"].map((candidate) => {
    if (!isRecord(candidate) || Object.keys(candidate).some((key) => !CANDIDATE_KEYS.has(key)) ||
        Object.keys(candidate).length !== CANDIDATE_KEYS.size) throw new GeoReferenceServiceError(400, "validation_failed");
    const nullableNumber = (key: string): number | null => {
      const field = candidate[key];
      if (field === null) return null;
      if (typeof field !== "number" || !Number.isFinite(field)) throw new GeoReferenceServiceError(400, "validation_failed");
      return field;
    };
    const nullableString = (key: string, max: number): string | null => {
      const field = candidate[key];
      if (field === null) return null;
      if (typeof field !== "string" || field.length > max) throw new GeoReferenceServiceError(400, "validation_failed");
      return field;
    };
    const sourceSnippet = candidate["sourceSnippet"];
    if (typeof sourceSnippet !== "string" || sourceSnippet.length < 1 || sourceSnippet.length > 1200) {
      throw new GeoReferenceServiceError(400, "validation_failed");
    }
    const confidence = candidate["confidence"];
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new GeoReferenceServiceError(400, "validation_failed");
    }
    return {
      latitude: nullableNumber("latitude"), longitude: nullableNumber("longitude"),
      chainageFrom: nullableNumber("chainageFrom"), chainageTo: nullableNumber("chainageTo"),
      assetCode: nullableString("assetCode", 128), placeName: nullableString("placeName", 256),
      sourceSnippet, confidence,
    };
  });
  return { references };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sendProblem(request: FastifyRequest, reply: FastifyReply, status: number, code: string) {
  const title: Record<string, string> = {
    validation_failed: "Request validation failed", unauthenticated: "Authentication required",
    forbidden: "Access denied", not_found: "Resource not found", conflict: "Request conflicts with current state",
    idempotency_key_reused: "Idempotency key was already used", source_unavailable: "Document text is unavailable",
    payload_too_large: "Document exceeds the extraction size limit", service_unavailable: "Geo Reference service unavailable",
  };
  return reply.code(status).type("application/problem+json").send({
    type: "about:blank", title: title[code] ?? "Geo Reference request could not be completed", status, code, traceId: request.id,
  });
}
