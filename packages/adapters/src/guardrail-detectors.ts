import { GoogleAuth } from "google-auth-library";

export type GuardrailClassification = "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "HIGHLY_RESTRICTED";

export interface Tier1ScanResult {
  action: "allow" | "redact" | "block";
  text: string;
  reason: string | null;
  classification: GuardrailClassification | null;
  findings: string[];
}

export interface Tier1TextScanner {
  scanUserPrompt(text: string): Promise<Tier1ScanResult>;
  scanModelResponse(text: string, userPrompt: string): Promise<Tier1ScanResult>;
}

export interface GuardrailAccessTokenProvider {
  getAccessToken(): Promise<string>;
}

export interface ModelArmorAdapterOptions {
  projectId: string;
  location: string;
  templateId: string;
  timeoutMs?: number;
  tokenProvider?: GuardrailAccessTokenProvider;
  transport?: typeof fetch;
}

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/** Uses a Model Armor template backed by Sensitive Data Protection inspect/de-identify templates. */
export class GoogleModelArmorAdapter implements Tier1TextScanner {
  private readonly tokenProvider: GuardrailAccessTokenProvider;
  private readonly transport: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: ModelArmorAdapterOptions) {
    if (!options.projectId || !options.location || !options.templateId) {
      throw new Error("Model Armor project, location and template are required");
    }
    this.timeoutMs = options.timeoutMs ?? 1_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) {
      throw new Error("Model Armor timeout must be between 1 and 30000 milliseconds");
    }
    this.transport = options.transport ?? fetch;
    this.tokenProvider = options.tokenProvider ?? new GoogleCloudAccessTokenProvider();
  }

  scanUserPrompt(text: string): Promise<Tier1ScanResult> {
    return this.sanitize("sanitizeUserPrompt", { userPromptData: { text } });
  }

  scanModelResponse(text: string, userPrompt: string): Promise<Tier1ScanResult> {
    return this.sanitize("sanitizeModelResponse", { modelResponseData: { text }, userPrompt: { text: userPrompt } });
  }

  private async sanitize(method: "sanitizeUserPrompt" | "sanitizeModelResponse", body: unknown): Promise<Tier1ScanResult> {
    const controller = new AbortController();
    let rejectTimeout: (error: Error) => void = () => undefined;
    const timeoutResult = new Promise<never>((_, reject) => { rejectTimeout = reject; });
    const timeout = setTimeout(() => {
      const error = new Error("Model Armor request timed out");
      controller.abort(error);
      rejectTimeout(error);
    }, this.timeoutMs);
    timeout.unref?.();
    try {
      const token = await Promise.race([this.tokenProvider.getAccessToken(), timeoutResult]);
      const name = `projects/${encodeURIComponent(this.options.projectId)}/locations/${encodeURIComponent(this.options.location)}/templates/${encodeURIComponent(this.options.templateId)}`;
      const url = `https://modelarmor.${this.options.location}.rep.googleapis.com/v1/${name}:${method}`;
      const response = await this.transport(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) throw new Error(`Model Armor returned HTTP ${response.status}`);
      const payload: unknown = await response.json();
      return parseSanitizationResult(payload);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class GoogleCloudAccessTokenProvider implements GuardrailAccessTokenProvider {
  private readonly auth: GoogleAuth;

  constructor(auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] })) {
    this.auth = auth;
  }

  async getAccessToken(): Promise<string> {
    const token = await this.auth.getAccessToken();
    if (!token) throw new Error("Google Cloud access token is unavailable");
    return token;
  }
}

function parseSanitizationResult(payload: unknown): Tier1ScanResult {
  const root = asRecord(payload);
  const result = asRecord(root?.["sanitizationResult"]);
  if (!result || result["invocationResult"] !== "SUCCESS") {
    throw new Error("Model Armor did not complete every Tier 1 filter");
  }

  const filters = result["filterResults"];
  const injectionMatch = hasNamedMatch(filters, /prompt|jailbreak/i);
  const sdpResult = findNamedValue(filters, /sdp/i);
  const findings = findInfoTypes(sdpResult);
  const matched = result["filterMatchState"] === "MATCH_FOUND";
  const hasSdpFinding = findings.length > 0;
  const unknownMatch = matched && !injectionMatch && !hasSdpFinding;

  if (injectionMatch || unknownMatch) {
    return {
      action: "block",
      text: "",
      reason: injectionMatch ? "Prompt injection or jailbreak detected" : "Model Armor reported an unclassified filter match",
      classification: null,
      findings,
    };
  }

  if (!hasSdpFinding) {
    return { action: "allow", text: "", reason: null, classification: null, findings: [] };
  }

  const redactedText = findDeidentifiedText(sdpResult);
  if (redactedText === null) {
    return {
      action: "block",
      text: "",
      reason: "Sensitive data was detected but safe redaction was unavailable",
      classification: classificationForInfoTypes(findings),
      findings,
    };
  }
  return {
    action: "redact",
    text: redactedText,
    reason: "Sensitive data was redacted by Sensitive Data Protection",
    classification: classificationForInfoTypes(findings),
    findings,
  };
}

function hasNamedMatch(value: unknown, namePattern: RegExp): boolean {
  if (Array.isArray(value)) return value.some((entry) => hasNamedMatch(entry, namePattern));
  const record = asRecord(value);
  if (!record) return false;
  return Object.entries(record).some(([key, child]) => {
    if (namePattern.test(key) && containsMatchState(child)) return true;
    return hasNamedMatch(child, namePattern);
  });
}

function containsMatchState(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsMatchState);
  const record = asRecord(value);
  if (!record) return false;
  return Object.entries(record).some(([key, child]) =>
    (key === "matchState" || key === "filterMatchState") && child === "MATCH_FOUND" ? true : containsMatchState(child));
}

function findNamedValue(value: unknown, namePattern: RegExp): unknown {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findNamedValue(entry, namePattern);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  for (const [key, child] of Object.entries(record)) {
    if (namePattern.test(key)) return child;
    const found = findNamedValue(child, namePattern);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findInfoTypes(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    const record = asRecord(node);
    if (!record) return;
    const infoTypes = record["infoTypes"];
    if (Array.isArray(infoTypes)) {
      for (const infoType of infoTypes) if (typeof infoType === "string") found.add(infoType);
    }
    const infoType = record["infoType"];
    if (typeof infoType === "string") found.add(infoType);
    else {
      const namedInfoType = asRecord(infoType);
      if (typeof namedInfoType?.["name"] === "string") found.add(namedInfoType["name"]);
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return [...found];
}

function findDeidentifiedText(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findDeidentifiedText(entry);
      if (found !== null) return found;
    }
    return null;
  }
  const record = asRecord(value);
  if (!record) return null;
  const deidentify = asRecord(record["deidentifyResult"]);
  const data = asRecord(deidentify?.["data"]);
  if (typeof data?.["text"] === "string") return data["text"];
  for (const child of Object.values(record)) {
    const found = findDeidentifiedText(child);
    if (found !== null) return found;
  }
  return null;
}

function classificationForInfoTypes(infoTypes: readonly string[]): GuardrailClassification {
  return infoTypes.some((infoType) => /SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE_KEY|API_KEY|ACCESS_KEY/i.test(infoType))
    ? "HIGHLY_RESTRICTED"
    : "CONFIDENTIAL";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
