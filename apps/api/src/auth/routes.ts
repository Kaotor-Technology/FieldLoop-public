import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AuthError, csrfMatches, isRecentAuthTime, safeReturnPath, type AuthServicePort, type CurrentUser } from "./service.js";

const SESSION_COOKIE = "fl_session";
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const PROBLEM_TYPE = "application/problem+json";
const RETURN_PATH_MAX_LENGTH = 2048;
const PUBLIC_ROUTES = new Set([
  "GET /healthz",
  "GET /health",
  "GET /api/auth/login",
  "GET /api/auth/callback",
  "POST /api/auth/backchannel-logout",
  "GET /api/internal/auth/jwks",
  // These exact routes perform their own signed-token verification in the handler.
  "GET /api/internal/assistant/documents/:documentId/geo-source",
  "POST /api/internal/assistant/documents/:documentId/geo-references",
]);
const CONSEQUENTIAL_DECISION =
  /^\/api\/v1\/(?:(?:held-requests|drafts)\/[^/]+:(?:approve|reject)|action-requests\/[^/]+(?:\/approvals|:(?:approve|reject|release|execute)))\/?$/;

declare module "fastify" {
  interface FastifyRequest {
    fieldLoopCurrentUser?: CurrentUser;
  }
}

export function registerAuthRoutes(app: FastifyInstance, auth: AuthServicePort, baseUrl: string | undefined): void {
  app.register(cookie);
  app.register(formbody);
  app.addHook("preHandler", async (request, reply) => {
    if (isPublicRoute(request)) return;
    const consequential = isConsequentialDecision(request);
    try {
      const currentUser = await auth.getCurrentUser(request.cookies[SESSION_COOKIE], consequential);
      request.fieldLoopCurrentUser = currentUser;
      if (consequential && !isRecentAuthTime(currentUser.authTime, new Date())) {
        return sendProblem(request, reply, 403, "reauthentication_required", "Recent reauthentication is required");
      }
      if (request.method !== "GET") {
        const csrfToken = request.headers["x-csrf-token"];
        if (Array.isArray(csrfToken) || !csrfMatches(currentUser.csrfToken, csrfToken)) {
          return sendProblem(request, reply, 403, "csrf_token_invalid", "CSRF token is missing or invalid");
        }
      }
    } catch (error) {
      // Only a top-level reference navigation starts SSO. Assets/spec stay 401,
      // and an IdP outage remains 503 rather than creating a redirect loop.
      if (error instanceof AuthError && error.statusCode === 401 && request.method === "GET" &&
          ["/api/reference", "/api/reference/", "/api/reference/index.html"].includes(request.routeOptions.url ?? "")) {
        return reply.header("cache-control", "private, no-store").redirect("/api/auth/login?return=%2Fapi%2Freference%2F", 302);
      }
      return sendAuthFailure(request, reply, error, "BFF authentication pre-handler failed");
    }
  });
  app.register(async (routes) => {
    routes.setErrorHandler((error: Error, request: FastifyRequest, reply: FastifyReply) =>
      sendAuthFailure(request, reply, error, "BFF authentication request failed"),
    );

    routes.get("/api/auth/login", async (request, reply) => {
      const authorizationUrl = await auth.startLogin(safeReturnPath(returnParameter(request)));
      return reply.header("cache-control", "no-store").redirect(authorizationUrl.toString(), 302);
    });

    routes.get("/api/auth/callback", async (request, reply) => {
      if (!baseUrl) throw new AuthError("FIELDLOOP_BASE_URL is not configured", 503);
      const result = await auth.completeLogin(new URL(request.url, baseUrl), request.cookies[SESSION_COOKIE]);
      reply.setCookie(SESSION_COOKIE, result.sessionCookieValue, sessionCookieOptions());
      return reply.header("cache-control", "no-store").redirect(new URL(safeReturnPath(result.returnPath), baseUrl).toString(), 303);
    });

    routes.post("/api/auth/logout", async (request, reply) => {
      const endSessionUrl = await auth.logout(request.cookies[SESSION_COOKIE]);
      reply.clearCookie(SESSION_COOKIE, { path: "/", secure: true, httpOnly: true, sameSite: "lax" });
      if (request.headers.accept?.includes("application/json")) {
        return reply.header("cache-control", "no-store").send({ redirectUrl: endSessionUrl.toString() });
      }
      return reply.header("cache-control", "no-store").redirect(endSessionUrl.toString(), 303);
    });

    routes.post("/api/auth/backchannel-logout", async (request, reply) => {
      const body = request.body;
      const token = body && typeof body === "object" ? (body as Record<string, unknown>)["logout_token"] : undefined;
      if (typeof token !== "string" || token.length === 0) {
        throw new AuthError("Missing back-channel logout token", 400);
      }
      await auth.backchannelLogout(token);
      return reply.header("cache-control", "no-store").code(204).send();
    });

    routes.get("/api/auth/reauth", async (request, reply) => {
      const authorizationUrl = await auth.startReauthentication(
        request.cookies[SESSION_COOKIE],
        safeReturnPath(returnParameter(request)),
      );
      return reply.header("cache-control", "no-store").redirect(authorizationUrl.toString(), 302);
    });

    routes.get("/api/v1/me", async (request, reply) => reply.header("cache-control", "no-store").send(request.fieldLoopCurrentUser));
    routes.get("/api/internal/auth/jwks", async () => auth.jwks());
  });
}

// Decided on the matched route pattern, never the raw URL: the router decodes before matching, so "/%61pi/..." reaches an /api handler.
function isPublicRoute(request: FastifyRequest): boolean {
  const routePattern = request.routeOptions.url;
  if (routePattern === undefined) return true;
  if (PUBLIC_ROUTES.has(`${request.method} ${routePattern}`)) return true;
  return request.method === "GET" && routePattern !== "/api" && !routePattern.startsWith("/api/");
}

function isConsequentialDecision(request: FastifyRequest): boolean {
  if (request.method !== "POST") return false;
  const rawPath = request.url.split("?", 1)[0] ?? "";
  try {
    return CONSEQUENTIAL_DECISION.test(decodeURIComponent(rawPath));
  } catch {
    return true;
  }
}

function returnParameter(request: FastifyRequest): string | undefined {
  const value = (request.query as Record<string, unknown>)["return"];
  return typeof value === "string" && value.length <= RETURN_PATH_MAX_LENGTH ? value : undefined;
}

function sendProblem(request: FastifyRequest, reply: FastifyReply, status: number, code: string, title: string) {
  return reply.code(status).type(PROBLEM_TYPE).send({ type: "about:blank", title, status, code, traceId: request.id });
}

function sendAuthFailure(request: FastifyRequest, reply: FastifyReply, error: unknown, logMessage: string) {
  if (error instanceof AuthError) return sendProblem(request, reply, error.statusCode, error.code, error.message);
  const frameworkStatus = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof frameworkStatus === "number" && frameworkStatus >= 400 && frameworkStatus < 500) {
    return sendProblem(request, reply, 400, "validation_failed", "Request could not be processed");
  }
  request.log.error({ err: error }, logMessage);
  return sendProblem(request, reply, 503, "service_unavailable", "Authentication service unavailable");
}

function sessionCookieOptions() {
  return {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}
