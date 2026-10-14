import type { FastifyInstance, FastifyRequest } from "fastify";
import { importMappingRequestSchema, type components } from "@fieldloop/contracts";
import { ImportError, MAX_UPLOAD_BYTES } from "./parser.js";
import type { ImportPort } from "./store.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keyPattern = /^[A-Za-z0-9._:-]{16,128}$/;
export function registerImportRoutes(app: FastifyInstance, imports?: ImportPort): void {
  app.register(async (routes) => {
    routes.setErrorHandler((error: unknown, request, reply) => {
      const status = error instanceof ImportError ? error.status : (error as { statusCode?: number })?.statusCode ?? 503;
      const code = problemCode(error, status);
      if (status >= 500) request.log.error({ errorType: error instanceof Error ? error.name : "unknown" },"Import request failed");
      return reply.code(status).type("application/problem+json").send({ type:"about:blank",title:"Import request could not be completed",status,code,traceId:request.id });
    });
    routes.addHook("preHandler", async (request,reply) => {
      reply.header("cache-control","private, no-store");
      const user = request.fieldLoopCurrentUser;
      if (!user) throw new ImportError(401,"unauthenticated");
      if (user.sub.startsWith("agent:") || !user.roles.some((role) => ["fieldloop.operator","fieldloop.manager"].includes(role))) throw new ImportError(403,"forbidden");
      if (!imports) throw new ImportError(503,"service_unavailable");
    });
    const service = () => { if (!imports) throw new ImportError(503,"service_unavailable"); return imports; };
    routes.get("/api/v1/imports/options", async (request) => service().options(currentUser(request)));
    routes.post("/api/v1/imports", { bodyLimit: Math.ceil(MAX_UPLOAD_BYTES * 4 / 3) + 1024 }, async (request) => {
      const body = object(request.body);
      const content = body["contentBase64"], format = body["format"];
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !keyPattern.test(key) || (format !== "kml" && format !== "kmz")
        || typeof content !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)
        || Object.keys(body).some((field) => !["format","contentBase64"].includes(field))) throw new ImportError(400,"validation_failed");
      return service().create(currentUser(request),Buffer.from(content,"base64"),format,key);
    });
    routes.get("/api/v1/imports/:importId/preview", async (request) => service().preview(currentUser(request),id(request.params)));
    routes.put("/api/v1/imports/:importId/mapping", async (request) => {
      const parsed = importMappingRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new ImportError(400,"validation_failed");
      return service().map(currentUser(request),id(request.params),parsed.data.version,parsed.data.mapping);
    });
    for (const command of ["commit","rollback"] as const) {
      routes.post(`/api/v1/imports/:importId([0-9a-fA-F-]{36})::${command}`, async (request) => {
        const body = object(request.body), key = request.headers["idempotency-key"];
        if (!Number.isInteger(body["version"]) || Number(body["version"]) < 1 || Object.keys(body).length !== 1
          || typeof key !== "string" || !keyPattern.test(key)) throw new ImportError(400,"validation_failed");
        return service().command(currentUser(request),id(request.params),Number(body["version"]),command,key);
      });
    }
  });
}
function object(value: unknown): Record<string,unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ImportError(400,"validation_failed");
  return value as Record<string,unknown>;
}
function id(params: unknown): string {
  const value = object(params)["importId"];
  if (typeof value !== "string" || !uuid.test(value)) throw new ImportError(400,"validation_failed"); return value;
}

function currentUser(request: FastifyRequest) {
  const user = request.fieldLoopCurrentUser;
  if (!user) throw new ImportError(401,"unauthenticated");
  return user;
}

function problemCode(error: unknown, status: number): components["schemas"]["ErrorCode"] {
  const internalCode = error instanceof ImportError ? error.code : undefined;
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return internalCode === "idempotency_key_reused" ? internalCode : "conflict";
  if (status === 413) return "payload_too_large";
  if (status === 405) return "method_not_allowed";
  if (status === 429) return "rate_limited";
  if (status === 400) return "validation_failed";
  if (status === 503) return "service_unavailable";
  return status >= 500 ? "internal_error" : "validation_failed";
}
