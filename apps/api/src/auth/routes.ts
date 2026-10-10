import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AuthError, csrfMatches, safeReturnPath, type AuthServicePort, type CurrentUser } from "./service.js";

const SESSION_COOKIE = "fl_session";
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const PROBLEM_TYPE = "application/problem+json";

declare module "fastify" {
  interface FastifyRequest {
    fieldLoopCurrentUser?: CurrentUser;
  }
}

export function registerAuthRoutes(app: FastifyInstance, auth: AuthServicePort, baseUrl: string | undefined): void {
  app.register(cookie);
  app.register(formbody);
  app.addHook("preHandler", async (request, reply) => {
    if (isPublicAuthRoute(request)) return;
    try {
      const currentUser = await auth.getCurrentUser(
        request.cookies[SESSION_COOKIE],
        isConsequentialDecision(request),
      );
      request.fieldLoopCurrentUser = currentUser;
      if (isConsequentialDecision(request)) {
        const authAgeMs = Date.now() - currentUser.authTime.getTime();
        if (authAgeMs < -30_000 || authAgeMs >= 5 * 60 * 1000) {
          return reply
            .code(403)
            .type(PROBLEM_TYPE)
            .send({
              type: "about:blank",
              title: "Recent reauthentication is required",
              status: 403,
              code: "reauthentication_required",
              traceId: request.id,
            });
        }
      }
      if (request.method !== "GET") {
        const csrfToken = request.headers["x-csrf-token"];
        if (Array.isArray(csrfToken) || !csrfMatches(currentUser.csrfToken, csrfToken)) {
          return reply
            .code(403)
            .type(PROBLEM_TYPE)
            .send({
              type: "about:blank",
              title: "CSRF token is missing or invalid",
              status: 403,
              code: "csrf_token_invalid",
              traceId: request.id,
            });
        }
      }
    } catch (error) {
      if (error instanceof AuthError) {
        return reply
          .code(error.statusCode)
          .type(PROBLEM_TYPE)
          .send({ type: "about:blank", title: error.message, status: error.statusCode, code: error.code, traceId: request.id });
      }
      request.log.error({ err: error }, "BFF authentication pre-handler failed");
      return reply
        .code(503)
        .type(PROBLEM_TYPE)
        .send({
          type: "about:blank",
          title: "Authentication service unavailable",
          status: 503,
          code: "service_unavailable",
          traceId: request.id,
        });
    }
  });
  app.register(async (routes) => {
    routes.setErrorHandler((error: Error, request: FastifyRequest, reply: FastifyReply) => {
      if (error instanceof AuthError) {
        return reply
          .code(error.statusCode)
          .type(PROBLEM_TYPE)
          .send({
            type: "about:blank",
            title: error.message,
            status: error.statusCode,
            code: error.code,
            traceId: request.id,
          });
      }
      request.log.error({ err: error }, "BFF authentication request failed");
      return reply
        .code(503)
        .type(PROBLEM_TYPE)
        .send({
          type: "about:blank",
          title: "Authentication service unavailable",
          status: 503,
          code: "service_unavailable",
          traceId: request.id,
        });
    });

    routes.get("/api/auth/login", async (request, reply) => {
      const query = request.query as { return?: string };
      const authorizationUrl = await auth.startLogin(safeReturnPath(query.return));
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
      const query = request.query as { return?: string };
      const authorizationUrl = await auth.startReauthentication(
        request.cookies[SESSION_COOKIE],
        safeReturnPath(query.return),
      );
      return reply.header("cache-control", "no-store").redirect(authorizationUrl.toString(), 302);
    });

    routes.get("/api/v1/me", async (request, reply) => reply.header("cache-control", "no-store").send(request.fieldLoopCurrentUser));
    routes.get("/api/internal/auth/jwks", async () => auth.jwks());
  });
}

function isPublicAuthRoute(request: FastifyRequest): boolean {
  return (
    (request.method === "GET" && !request.url.startsWith("/api/")) ||
    (request.method === "GET" && (request.url.startsWith("/api/auth/login") || request.url.startsWith("/api/auth/callback"))) ||
    (request.method === "POST" && request.url.startsWith("/api/auth/backchannel-logout")) ||
    (request.method === "GET" && request.url.startsWith("/api/internal/auth/jwks"))
  );
}

function isConsequentialDecision(request: FastifyRequest): boolean {
  return (
    request.method === "POST" &&
    /\/api\/v1\/(?:held-requests|drafts)\/[^/]+:(?:approve|reject)(?:\?|$)|\/api\/v1\/action-requests\/[^/]+:(?:approve|reject|release|execute)(?:\?|$)/.test(
      request.url,
    )
  );
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
