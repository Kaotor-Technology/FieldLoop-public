import type { GuardrailClassification, Tier1ScanResult, Tier1TextScanner, VertexChatCompletions } from "@fieldloop/adapters";
import type { InternalUserTokenVerifier } from "./internal-user-token.js";
export type { GuardrailClassification };

export type GuardrailDecision = "allow" | "redact" | "block" | "reroute";
export type GuardrailPolicyKind = "injection" | "classification-routing" | "output-dlp";

export interface GuardrailPolicy {
  id: string;
  code: string;
  barrierId: string;
  kind: string;
  mode: string;
  failMode: string;
  config: Record<string, unknown>;
}

export interface ModelRoute {
  tier: string;
  enabled: boolean;
  boundary: string;
  modelClass: string;
}

export interface GuardrailSystem {
  id: string;
  code: string;
  orgId: string;
  simulated: boolean;
  classification: GuardrailClassification;
  dataClasses: GuardrailClassification[];
  modelRoutes: ModelRoute[];
  policies: GuardrailPolicy[];
}

export interface RecordInterceptInput {
  system: GuardrailSystem;
  policy: GuardrailPolicy;
  decision: GuardrailDecision;
  reason: string;
  latencyMs: number;
  classification: GuardrailClassification;
}

export interface StoredContentScan {
  requestHash: string;
  statusCode: number;
  decision: GuardrailDecision;
  classification: GuardrailClassification;
  reason: string;
  policyId: string;
  interceptId: string;
}

export interface RecordContentScanInput {
  system: GuardrailSystem;
  idempotencyKeyHash: string;
  requestHash: string;
  records: RecordInterceptInput[];
  result: Omit<StoredContentScan, "requestHash" | "interceptId">;
  primaryRecordIndex: number;
}

export class IdempotencyKeyReusedError extends Error {
  constructor() {
    super("Idempotency key was already used with a different request");
    this.name = "IdempotencyKeyReusedError";
  }
}

export interface GuardrailStore {
  loadSystem(code: string, orgId: string, simulated: boolean): Promise<GuardrailSystem>;
  recordIntercept(input: RecordInterceptInput): Promise<string>;
  getContentScan(orgId: string, idempotencyKeyHash: string): Promise<StoredContentScan | null>;
  recordContentScan(input: RecordContentScanInput): Promise<StoredContentScan>;
}

export interface GuardrailDependencies {
  store: GuardrailStore;
  scanner: Tier1TextScanner;
  model: VertexChatCompletions;
  userTokenVerifier: InternalUserTokenVerifier;
  orgId: string;
  simulated: boolean;
  vertexModels: Readonly<Record<"flash" | "pro", string>>;
  /** Receives errors that are answered with a generic fail-closed response, so operators can see the cause. */
  logError?: (error: unknown, message: string) => void;
}

export interface ChatCompletionRequest {
  ai_system: string;
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  [key: string]: unknown;
}

export interface ChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | null;
  [key: string]: unknown;
}

export interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices: Array<{ index?: number; message?: Record<string, unknown>; finish_reason?: string | null; [key: string]: unknown }>;
  [key: string]: unknown;
}

export function isClassification(value: unknown): value is GuardrailClassification {
  return value === "PUBLIC" || value === "INTERNAL" || value === "CONFIDENTIAL" || value === "HIGHLY_RESTRICTED";
}

export function classificationRank(value: GuardrailClassification): number {
  return ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED"].indexOf(value);
}

export function raiseClassification(
  current: GuardrailClassification,
  detected: Tier1ScanResult["classification"],
): GuardrailClassification {
  return detected && classificationRank(detected) > classificationRank(current) ? detected : current;
}
