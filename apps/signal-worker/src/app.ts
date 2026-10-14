import Fastify from "fastify";
import { isPubSubPush, isSignal, type components } from "@fieldloop/contracts";
import { MAX_SIGNAL_BYTES } from "@fieldloop/adapters";
import { WorkerError, type WorkerRuntime } from "./model.js";

export function buildApp(runtime?: WorkerRuntime) {
  const app = Fastify({ logger: { redact: ["req.headers.authorization"] }, bodyLimit: 400_000 });
  app.get("/healthz", async () => ({ status: "ok" }));
  app.setErrorHandler((error, request, reply) => {
    const httpStatus = error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 503;
    const status = error instanceof WorkerError ? error.status : httpStatus < 500 ? httpStatus : 503;
    if (status >= 500) request.log.error({ errorName: error instanceof Error ? error.name : "UnknownError", traceId: request.id, status }, "Signal worker request failed");
    const problem: components["schemas"]["Problem"] = {
      type: "about:blank", title: status >= 500 ? "Service unavailable" : "Request rejected", status,
      code: status >= 500 ? "service_unavailable" : status === 401 ? "unauthenticated" : status === 403 ? "forbidden" : status === 409 ? "conflict" : "validation_failed",
      detail: error instanceof WorkerError ? error.message : status >= 500 ? "Signal processing did not complete" : "Invalid request",
      instance: request.url,
      traceId: request.id,
    };
    void reply.code(status).type("application/problem+json").send(problem);
  });
  async function authenticate(authorization: string | undefined, kind: "push" | "scheduler") {
    if (!runtime) throw new WorkerError("Signal worker is not configured", 503);
    const token = authorization?.match(/^Bearer ([^\s]+)$/)?.[1];
    if (!token) throw new WorkerError("A service OIDC token is required", 401);
    try { await runtime.identity.verify(token, runtime.audience, kind === "push" ? runtime.pushEmail : runtime.schedulerEmail); }
    catch { throw new WorkerError("Service OIDC token rejected", 401); }
    return runtime;
  }
  app.post("/internal/pubsub/signals", {
    onRequest: async (request) => { await authenticate(request.headers.authorization, "push"); },
  }, async (request, reply) => {
    if (!runtime) throw new WorkerError("Signal worker is not configured", 503);
    const body: unknown = request.body;
    if (!isPubSubPush(body) || body.subscription !== runtime.subscription) throw new WorkerError("Invalid Pub/Sub envelope", 400);
    const encoded = body.message.data;
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length > MAX_SIGNAL_BYTES || bytes.toString("base64") !== encoded) throw new WorkerError("Invalid Signal encoding", 400);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new WorkerError("Signal must be UTF-8 JSON", 400); }
    if (!isSignal(value)) throw new WorkerError("Invalid signal.v1 message", 400);
    const attributes = body.message.attributes;
    if (value.orgId !== runtime.orgId || attributes["orgId"] !== runtime.orgId || attributes["environment"] !== runtime.environment
      || attributes["signalId"] !== value.id || attributes["schemaVersion"] !== value.schemaVersion
      || attributes["simulated"] !== String(value.simulated) || attributes["classification"] !== value.classification
      || (runtime.simulatedOnly && !value.simulated)) throw new WorkerError("Unexpected Signal provenance", 403);
    await runtime.store.ingest(value);
    await runtime.store.publishPending(runtime.publish);
    return reply.code(204).send();
  });
  app.post("/internal/jobs/silent-sources", {
    onRequest: async (request) => { await authenticate(request.headers.authorization, "scheduler"); },
  }, async () => {
    if (!runtime) throw new WorkerError("Signal worker is not configured", 503);
    const changed = await runtime.store.detectSilence(new Date());
    await runtime.store.publishPending(runtime.publish);
    return { changed };
  });
  app.post("/internal/jobs/ageing", {
    onRequest: async (request) => { await authenticate(request.headers.authorization, "scheduler"); },
  }, async () => {
    if (!runtime) throw new WorkerError("Signal worker is not configured", 503);
    const result = await runtime.store.ageEvidence(new Date());
    await runtime.store.publishPending(runtime.publish);
    return result;
  });
  if (runtime) app.addHook("onClose", runtime.close);
  return app;
}
