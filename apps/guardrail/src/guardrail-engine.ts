import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { GuardrailClassification, Tier1ScanResult } from "@fieldloop/adapters";
import {
  classificationRank,
  IdempotencyKeyReusedError,
  raiseClassification,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type GuardrailDependencies,
  type GuardrailPolicy,
  type GuardrailSystem,
  type ModelRoute,
  type RecordContentScanInput,
  type RecordInterceptInput,
  type StoredContentScan,
} from "./model.js";
import { UnknownGuardrailSystemError } from "./postgres-store.js";

export interface GuardrailHttpResult {
  statusCode: number;
  body: unknown;
  policyId?: string;
  interceptId?: string;
  classification?: GuardrailClassification;
}

interface ContentScanInput {
  aiSystem: string;
  content: string;
  classification: GuardrailClassification;
  clearance: GuardrailClassification;
  idempotencyKey: string;
}

export class GuardrailEngine {
  constructor(private readonly dependencies: GuardrailDependencies) {}

  async scanContent(input: ContentScanInput): Promise<GuardrailHttpResult> {
    const loaded = await this.load(input.aiSystem);
    if ("result" in loaded) return loaded.result;
    const { system } = loaded;
    const injection = findPolicy(system, "injection");
    const routing = findPolicy(system, "classification-routing");
    if (!injection || !routing) return unavailable("Required Tier 1 policies are unavailable");

    const idempotencyKeyHash = sha256(input.idempotencyKey);
    const requestHash = sha256(JSON.stringify([system.id, input.classification, input.content]));
    let previous: StoredContentScan | null;
    try { previous = await this.dependencies.store.getContentScan(system.orgId, idempotencyKeyHash); }
    catch { return unavailable("Content scan idempotency record is unavailable"); }
    if (previous) {
      if (previous.requestHash !== requestHash) return idempotencyConflict();
      if (classificationRank(previous.classification) > classificationRank(input.clearance)) {
        return clearanceDenied(routing, input.clearance);
      }
      return contentScanResult(previous, input.content);
    }

    if (classificationRank(input.classification) > classificationRank(input.clearance)) {
      const reason = "Request classification exceeds the caller's clearance";
      return await this.persistContentScan(system, input, idempotencyKeyHash, requestHash, [{
        system, policy: routing, decision: "block", reason, classification: input.classification, latencyMs: 0,
      }], { statusCode: 403, decision: "block", classification: input.classification, reason, policyId: routing.id }, 0);
    }

    const startedAt = performance.now();
    let scan: Tier1ScanResult;
    try {
      scan = await this.dependencies.scanner.scanUserPrompt(input.content);
    } catch {
      return await this.persistContentScan(system, input, idempotencyKeyHash, requestHash, [{
        system, policy: injection, decision: "block", reason: "Tier 1 detector unavailable",
        classification: input.classification, latencyMs: elapsedMs(startedAt),
      }], {
        statusCode: 503, decision: "block", classification: input.classification,
        reason: "Tier 1 detector unavailable", policyId: injection.id,
      }, 0);
    }

    const classification = raiseClassification(input.classification, scan.classification);
    const detectedInjection = scan.action === "block";
    const enforce = injection.mode === "enforce";
    const injectionDecision = detectedInjection && enforce ? "block" : "allow";
    const injectionReason = detectedInjection
      ? (enforce ? "Potential prompt injection was detected in the supplied content" : "Prompt injection match observed in monitor mode")
      : "Tier 1 content scan completed";
    const records: RecordInterceptInput[] = [{
      system, policy: injection, decision: injectionDecision, reason: injectionReason,
      classification, latencyMs: elapsedMs(startedAt),
    }];
    if (detectedInjection && enforce) {
      return await this.persistContentScan(system, input, idempotencyKeyHash, requestHash, records, {
        statusCode: 403, decision: "block", classification, reason: injectionReason, policyId: injection.id,
      }, 0);
    }

    if (classificationRank(classification) > classificationRank(input.clearance)) {
      const reason = "Detected content classification exceeds the caller's clearance";
      records.push({ system, policy: routing, decision: "block", reason, classification, latencyMs: elapsedMs(startedAt) });
      return await this.persistContentScan(system, input, idempotencyKeyHash, requestHash, records, {
        statusCode: 403, decision: "block", classification, reason, policyId: routing.id,
      }, records.length - 1);
    }

    if (!system.dataClasses.includes(classification)) {
      records.push({ system, policy: routing, decision: "block", reason: "Detected content classification is not registered for this AI System", classification, latencyMs: elapsedMs(startedAt) });
      return await this.persistContentScan(system, input, idempotencyKeyHash, requestHash, records, {
        statusCode: 403, decision: "block", classification, reason: "Detected content classification is not registered for this AI System", policyId: routing.id,
      }, 1);
    }
    if (classificationRank(classification) > classificationRank(input.classification) || scan.action === "redact") {
      const allowedTiers = allowedModelTiers(routing, classification);
      const eligible = system.modelRoutes.some((route) => isEligibleRoute(route, allowedTiers));
      if (!eligible) {
        const reason = "No private model tier is allowed for the detected classification";
        records.push({ system, policy: routing, decision: "block", reason, classification, latencyMs: elapsedMs(startedAt) });
        return await this.persistContentScan(system, input, idempotencyKeyHash, requestHash, records, {
          statusCode: 403, decision: "block", classification, reason, policyId: routing.id,
        }, 1);
      }
      const reason = "Sensitive data requires the configured private model tier";
      records.push({ system, policy: routing, decision: "reroute", reason, classification, latencyMs: elapsedMs(startedAt) });
      return await this.persistContentScan(system, input, idempotencyKeyHash, requestHash, records, {
        statusCode: 200, decision: "reroute", classification, reason, policyId: routing.id,
      }, 1);
    }

    return await this.persistContentScan(system, input, idempotencyKeyHash, requestHash, records, {
      statusCode: 200, decision: "allow", classification, reason: injectionReason, policyId: injection.id,
    }, 0);
  }

  async chatCompletion(request: ChatCompletionRequest, classification: GuardrailClassification, clearance: GuardrailClassification): Promise<GuardrailHttpResult> {
    const loaded = await this.load(request.ai_system);
    if ("result" in loaded) return loaded.result;
    const { system } = loaded;
    const injection = findPolicy(system, "injection");
    const routing = findPolicy(system, "classification-routing");
    const outputDlp = findPolicy(system, "output-dlp");
    if (!injection || !routing || !outputDlp) return unavailable("Required Tier 1 policies are unavailable");
    if (!system.dataClasses.includes(classification)) {
      return await this.deny(system, routing, "Request classification is not registered for this AI System", classification, performance.now());
    }

    const startedAt = performance.now();
    if (classificationRank(classification) > classificationRank(clearance)) {
      return await this.deny(system, routing, "Request classification exceeds the caller's clearance", classification, startedAt);
    }
    const inputSegments = request.messages
      .filter((message) => message.role === "user" || message.role === "tool")
      .flatMap((message) => typeof message.content === "string" && message.content.length > 0
        ? [{ get: () => message.content as string, set: (value: string) => { message.content = value; } }]
        : []);
    let effectiveClassification = classification;
    if (inputSegments.length > 0) {
      const joined = joinSegments(inputSegments.map((segment) => segment.get()));
      let scan: Tier1ScanResult;
      try {
        scan = await this.dependencies.scanner.scanUserPrompt(joined.text);
      } catch {
        return await this.failClosed(system, injection, "Tier 1 detector unavailable", effectiveClassification, startedAt);
      }
      effectiveClassification = raiseClassification(effectiveClassification, scan.classification);
      if (classificationRank(effectiveClassification) > classificationRank(clearance)) {
        const intercept = await this.record(system, routing, "block", "Detected request classification exceeds the caller's clearance", effectiveClassification, startedAt);
        if ("result" in intercept) return intercept.result;
        return blocked(routing, intercept.id, "Detected request classification exceeds the caller's clearance", effectiveClassification);
      }
      const detectedInjection = scan.action === "block";
      const enforcedBlock = detectedInjection && injection.mode === "enforce";
      const reason = detectedInjection
        ? (enforcedBlock ? "Potential prompt injection was detected in the request" : "Prompt injection match observed in monitor mode")
        : "Tier 1 input scan completed";
      const intercept = await this.record(system, injection, enforcedBlock ? "block" : "allow", reason, effectiveClassification, startedAt);
      if ("result" in intercept) return intercept.result;
      if (enforcedBlock) return blocked(injection, intercept.id, reason, effectiveClassification);
      if (scan.action === "redact") {
        const replacements = splitSegments(scan.text, joined.separator, inputSegments.length);
        if (!replacements) return await this.failClosed(system, injection, "Safe input classification could not be applied", effectiveClassification, startedAt);
        replacements.forEach((value, index) => inputSegments[index]?.set(value));
      }
    } else {
      const intercept = await this.record(system, injection, "allow", "No untrusted text was present in the request", effectiveClassification, startedAt);
      if ("result" in intercept) return intercept.result;
    }

    if (!system.dataClasses.includes(effectiveClassification)) {
      return await this.deny(system, routing, "Detected request classification is not registered for this AI System", effectiveClassification, startedAt);
    }
    const requestedModelClass = request.model === "pro" || request.model === "flash" ? request.model : "flash";
    const route = selectRoute(system, routing, effectiveClassification, requestedModelClass, this.dependencies.vertexModels);
    if (!route) return await this.deny(system, routing, "No allowed private model route is available for this classification", effectiveClassification, startedAt);
    const rerouted = route.modelClass !== requestedModelClass || effectiveClassification !== classification;
    const routeReason = rerouted
      ? `Request routed to the configured private ${route.modelClass} model for ${effectiveClassification} data`
      : `Request routed to the configured private ${route.modelClass} model`;
    const routeIntercept = await this.record(system, routing, rerouted ? "reroute" : "allow", routeReason, effectiveClassification, startedAt);
    if ("result" in routeIntercept) return routeIntercept.result;

    let completion: unknown;
    try {
      const modelRequest = { ...request } as Record<string, unknown>;
      delete modelRequest["ai_system"];
      delete modelRequest["model"];
      delete modelRequest["stream"];
      completion = await this.dependencies.model.complete(route.model, modelRequest);
    } catch {
      return await this.failClosed(system, routing, "Model service unavailable", effectiveClassification, startedAt);
    }

    const response = asRecord(completion) as ChatCompletionResponse | null;
    if (!response || !Array.isArray(response.choices)) {
      return await this.failClosed(system, outputDlp, "Model returned an invalid completion", effectiveClassification, startedAt);
    }
    const outputSegments = collectOutputSegments(response);
    if (outputSegments.length === 0) {
      const outputIntercept = await this.record(system, outputDlp, "allow", "Model response contained no scannable text", effectiveClassification, startedAt);
      if ("result" in outputIntercept) return outputIntercept.result;
      return { statusCode: 200, body: response, policyId: outputDlp.id, interceptId: outputIntercept.id, classification: effectiveClassification };
    }

    const prompt = inputSegments.map((segment) => segment.get()).join("\n");
    const joinedOutput = joinSegments(outputSegments.map((segment) => segment.get()));
    let outputScan: Tier1ScanResult;
    try {
      outputScan = await this.dependencies.scanner.scanModelResponse(joinedOutput.text, prompt);
    } catch {
      return await this.failClosed(system, outputDlp, "Tier 1 output detector unavailable", effectiveClassification, startedAt);
    }
    const outputClassification = raiseClassification(effectiveClassification, outputScan.classification);
    const outputExceedsClearance = classificationRank(outputClassification) > classificationRank(clearance);
    const outputBlock = outputExceedsClearance || outputScan.action === "block" && outputDlp.mode === "enforce";
    const outputRedact = outputScan.action === "redact" && outputDlp.mode === "enforce";
    const outputDecision = outputBlock ? "block" : outputRedact ? "redact" : "allow";
    const outputReason = outputExceedsClearance
      ? "Model response classification exceeds the caller's clearance"
      : outputBlock ? "Model response did not pass Tier 1 output checks"
      : outputRedact ? "Sensitive values were redacted from the model response" : "Tier 1 output scan completed";
    const outputIntercept = await this.record(system, outputDlp, outputDecision, outputReason, outputClassification, startedAt);
    if ("result" in outputIntercept) return outputIntercept.result;
    if (outputBlock) return blocked(outputDlp, outputIntercept.id, outputReason, outputClassification);
    if (outputRedact) {
      const replacements = splitSegments(outputScan.text, joinedOutput.separator, outputSegments.length);
      if (!replacements) return await this.failClosed(system, outputDlp, "Safe output redaction could not be applied", outputClassification, startedAt);
      try { replacements.forEach((value, index) => outputSegments[index]?.set(value)); }
      catch { return await this.failClosed(system, outputDlp, "Safe output redaction could not be applied", outputClassification, startedAt); }
    }

    return {
      statusCode: 200,
      body: response,
      policyId: outputDlp.id,
      interceptId: outputIntercept.id,
      classification: outputClassification,
    };
  }

  private async load(code: string): Promise<{ system: GuardrailSystem } | { result: GuardrailHttpResult }> {
    try {
      return { system: await this.dependencies.store.loadSystem(code, this.dependencies.orgId, this.dependencies.simulated) };
    } catch (error) {
      if (error instanceof UnknownGuardrailSystemError) return { result: { statusCode: 404, body: errorBody("not_found", "AI System is not registered", 404, "unknown_ai_system") } };
      return { result: unavailable("AI System policy configuration is unavailable") };
    }
  }

  private async record(
    system: GuardrailSystem,
    policy: GuardrailPolicy,
    decision: RecordInterceptInput["decision"],
    reason: string,
    classification: GuardrailClassification,
    startedAt: number,
  ): Promise<{ id: string } | { result: GuardrailHttpResult }> {
    try {
      const id = await this.dependencies.store.recordIntercept({
        system, policy, decision, reason, classification, latencyMs: elapsedMs(startedAt),
      });
      return { id };
    } catch {
      return { result: unavailable("Guardrail decision could not be recorded") };
    }
  }

  private async failClosed(
    system: GuardrailSystem,
    policy: GuardrailPolicy,
    reason: string,
    classification: GuardrailClassification,
    startedAt: number,
  ): Promise<GuardrailHttpResult> {
    const recorded = await this.record(system, policy, "block", reason, classification, startedAt);
    if ("result" in recorded) return recorded.result;
    return {
      statusCode: 503,
      body: errorBody("service_unavailable", "Tier 1 checks could not safely allow this request", 503, "guardrail_blocked", policy.id),
      policyId: policy.id,
      interceptId: recorded.id,
      classification,
    };
  }

  private async persistContentScan(
    system: GuardrailSystem,
    input: ContentScanInput,
    idempotencyKeyHash: string,
    requestHash: string,
    records: RecordInterceptInput[],
    result: RecordContentScanInput["result"],
    primaryRecordIndex: number,
  ): Promise<GuardrailHttpResult> {
    try {
      const stored = await this.dependencies.store.recordContentScan({
        system, idempotencyKeyHash, requestHash, records, result, primaryRecordIndex,
      });
      return contentScanResult(stored, input.content);
    } catch (error) {
      if (error instanceof IdempotencyKeyReusedError) return idempotencyConflict();
      return unavailable("Content scan and Evidence could not be recorded");
    }
  }

  private async deny(
    system: GuardrailSystem,
    policy: GuardrailPolicy,
    reason: string,
    classification: GuardrailClassification,
    startedAt: number,
  ): Promise<GuardrailHttpResult> {
    const recorded = await this.record(system, policy, "block", reason, classification, startedAt);
    if ("result" in recorded) return recorded.result;
    return blocked(policy, recorded.id, reason, classification);
  }
}

function findPolicy(system: GuardrailSystem, kind: string): GuardrailPolicy | undefined {
  return system.policies.find((policy) => policy.kind === kind && policy.mode === "enforce" && policy.failMode === "fail-closed")
    ?? system.policies.find((policy) => policy.kind === kind && policy.mode === "monitor" && policy.failMode === "fail-closed");
}

function allowedModelTiers(policy: GuardrailPolicy, classification: GuardrailClassification): Set<string> {
  const settings = asRecord(policy.config["settings"]);
  const routes = settings?.["routes"];
  if (!Array.isArray(routes)) return new Set();
  const configured = routes.map(asRecord).find((route) => route?.["classification"] === classification)?.["allowedModelTiers"];
  return Array.isArray(configured) ? new Set(configured.filter((tier): tier is string => typeof tier === "string")) : new Set();
}

function isEligibleRoute(route: ModelRoute, allowedTiers: Set<string>): boolean {
  return route.enabled && allowedTiers.has(route.tier) && route.tier === "private"
    && route.boundary === "private-in-country-no-retention";
}

function selectRoute(
  system: GuardrailSystem,
  policy: GuardrailPolicy,
  classification: GuardrailClassification,
  requestedModelClass: "flash" | "pro",
  vertexModels: Readonly<Record<"flash" | "pro", string>>,
): { modelClass: "flash" | "pro"; model: string } | undefined {
  const allowedTiers = allowedModelTiers(policy, classification);
  const eligible = system.modelRoutes.filter((route) => isEligibleRoute(route, allowedTiers)
    && (route.modelClass === "flash" || route.modelClass === "pro"));
  const preferred = eligible.find((route) => route.modelClass === requestedModelClass && vertexModels[requestedModelClass]);
  const fallback = preferred ?? eligible.find((route) => route.modelClass === "flash" && vertexModels.flash);
  if (!fallback) return undefined;
  const modelClass = fallback.modelClass === "pro" ? "pro" : "flash";
  return { modelClass, model: vertexModels[modelClass] };
}

function collectOutputSegments(response: ChatCompletionResponse): Array<{ get: () => string; set: (value: string) => void }> {
  const segments: Array<{ get: () => string; set: (value: string) => void }> = [];
  for (const choice of response.choices) {
    const message = asRecord(choice.message);
    if (!message) continue;
    if (typeof message["content"] === "string") {
      segments.push({ get: () => message["content"] as string, set: (value) => { message["content"] = value; } });
    }
    const calls = message["tool_calls"];
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      const functionCall = asRecord(asRecord(call)?.["function"]);
      if (functionCall && typeof functionCall["arguments"] === "string") {
        segments.push({
          get: () => functionCall["arguments"] as string,
          set: (value) => {
            try { JSON.parse(value); }
            catch { throw new UnsafeRedactionError(); }
            functionCall["arguments"] = value;
          },
        });
      }
    }
  }
  return segments;
}

function joinSegments(values: string[]): { text: string; separator: string } {
  let separator = `\n\n[FIELDLOOP-${randomUUID()}]\n\n`;
  while (values.some((value) => value.includes(separator))) separator = `\n\n[FIELDLOOP-${randomUUID()}]\n\n`;
  return { text: values.join(separator), separator };
}

function splitSegments(value: string, separator: string, expectedLength: number): string[] | null {
  const pieces = value.split(separator);
  return pieces.length === expectedLength ? pieces : null;
}

function blocked(
  policy: GuardrailPolicy,
  interceptId: string,
  reason: string,
  classification: GuardrailClassification,
): GuardrailHttpResult {
  return {
    statusCode: 403,
    body: errorBody("guardrail_blocked", reason, 403, "guardrail_blocked", policy.id),
    policyId: policy.id,
    interceptId,
    classification,
  };
}

function contentScanResult(result: StoredContentScan, content: string): GuardrailHttpResult {
  if (result.statusCode === 403) {
    return {
      statusCode: 403,
      body: errorBody("guardrail_blocked", result.reason, 403, "guardrail_blocked", result.policyId),
      policyId: result.policyId,
      interceptId: result.interceptId,
      classification: result.classification,
    };
  }
  if (result.statusCode === 503) {
    return {
      statusCode: 503,
      body: errorBody("service_unavailable", "Tier 1 checks could not safely allow this content", 503, "guardrail_blocked", result.policyId),
      policyId: result.policyId,
      interceptId: result.interceptId,
      classification: result.classification,
    };
  }
  return {
    statusCode: 200,
    body: { decision: result.decision, content, classification: result.classification, reason: result.reason, policyId: result.policyId },
    policyId: result.policyId,
    interceptId: result.interceptId,
    classification: result.classification,
  };
}

function idempotencyConflict(): GuardrailHttpResult {
  return {
    statusCode: 409,
    body: errorBody("idempotency_key_reused", "Idempotency key was already used for different content", 409, "idempotency_key_reused"),
  };
}

function clearanceDenied(policy: GuardrailPolicy, classification: GuardrailClassification): GuardrailHttpResult {
  const reason = "Stored content classification exceeds the caller's clearance";
  return {
    statusCode: 403,
    body: errorBody("clearance_denied", reason, 403, "clearance_denied", policy.id),
    policyId: policy.id,
    classification,
  };
}

function unavailable(message: string): GuardrailHttpResult {
  return { statusCode: 503, body: errorBody("service_unavailable", message, 503, "guardrail_unavailable") };
}

function errorBody(code: string, message: string, status: number, errorCode: string, policyId?: string): Record<string, unknown> {
  const title = status === 400 ? "Invalid Guardrail request" : status === 403 ? "Guardrail blocked the request"
    : status === 404 ? "AI System not found" : status === 409 ? "Idempotency key conflict" : "Guardrail unavailable";
  const error: Record<string, unknown> = { type: "guardrail_error", code: errorCode, message };
  const problem: Record<string, unknown> = {
    type: `urn:fieldloop:problem:${code}`,
    title,
    status,
    detail: message,
    code,
    error,
  };
  if (policyId) {
    problem["policyId"] = policyId;
    error["policy_id"] = policyId;
  }
  return problem;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.min(2_147_483_647, Math.round(performance.now() - startedAt)));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class UnsafeRedactionError extends Error {}
