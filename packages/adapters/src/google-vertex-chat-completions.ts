import { GoogleAuth } from "google-auth-library";
import type { GuardrailAccessTokenProvider } from "./guardrail-detectors.js";

export interface VertexChatCompletionsOptions {
  projectId: string;
  location: string;
  timeoutMs?: number;
  tokenProvider?: GuardrailAccessTokenProvider;
  transport?: typeof fetch;
}

export interface VertexChatCompletions {
  complete(model: string, request: Record<string, unknown>): Promise<unknown>;
}

/** Sends OpenAI Chat Completions requests to the Vertex AI OpenAI-compatible endpoint. */
export class GoogleVertexChatCompletionsAdapter implements VertexChatCompletions {
  private readonly tokenProvider: GuardrailAccessTokenProvider;
  private readonly transport: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: VertexChatCompletionsOptions) {
    if (!options.projectId || !options.location) throw new Error("Vertex AI project and location are required");
    this.timeoutMs = options.timeoutMs ?? 60_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000) {
      throw new Error("Vertex AI timeout must be between 1 and 300000 milliseconds");
    }
    this.transport = options.transport ?? fetch;
    this.tokenProvider = options.tokenProvider ?? new GoogleVertexAccessTokenProvider();
  }

  async complete(model: string, request: Record<string, unknown>): Promise<unknown> {
    if (!model || model.length > 256) throw new Error("Vertex AI model is invalid");
    const controller = new AbortController();
    const timeoutError = new Error("Vertex AI request timed out");
    let rejectTimeout: (error: Error) => void = () => undefined;
    const timeoutResult = new Promise<never>((_, reject) => { rejectTimeout = reject; });
    const timeout = setTimeout(() => {
      controller.abort(timeoutError);
      rejectTimeout(timeoutError);
    }, this.timeoutMs);
    timeout.unref?.();
    try {
      const token = await Promise.race([this.tokenProvider.getAccessToken(), timeoutResult]);
      const url = `https://${this.options.location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(this.options.projectId)}/locations/${encodeURIComponent(this.options.location)}/endpoints/openapi/chat/completions`;
      const response = await this.transport(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ ...request, model, stream: false }),
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) throw new Error(`Vertex AI returned HTTP ${response.status}`);
      return await response.json() as unknown;
    } finally {
      clearTimeout(timeout);
    }
  }
}

class GoogleVertexAccessTokenProvider implements GuardrailAccessTokenProvider {
  private readonly auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });

  async getAccessToken(): Promise<string> {
    const token = await this.auth.getAccessToken();
    if (!token) throw new Error("Google Cloud access token is unavailable");
    return token;
  }
}
