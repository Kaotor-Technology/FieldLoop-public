import { expect, it, vi } from "vitest";
import { GoogleVertexChatCompletionsAdapter } from "../src/google-vertex-chat-completions.js";

it("uses the regional OpenAI-compatible endpoint and overrides caller model and streaming", async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [] }), { status: 200 }));
  const adapter = new GoogleVertexChatCompletionsAdapter({
    projectId: "project-id", location: "asia-southeast1", tokenProvider: { getAccessToken: async () => "test-token" }, transport,
  });

  await adapter.complete("gemini-flash", { model: "external-model", stream: true, messages: [{ role: "user", content: "hello" }] });
  const [url, init] = transport.mock.calls[0] ?? [];
  expect(url).toBe("https://asia-southeast1-aiplatform.googleapis.com/v1/projects/project-id/locations/asia-southeast1/endpoints/openapi/chat/completions");
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
  expect(JSON.parse(String(init?.body))).toEqual({ model: "google/gemini-flash", stream: false, messages: [{ role: "user", content: "hello" }] });
});

it("does not follow redirects or return model errors as successful completions", async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("denied", { status: 403 }));
  const adapter = new GoogleVertexChatCompletionsAdapter({
    projectId: "project-id", location: "asia-southeast1", tokenProvider: { getAccessToken: async () => "test-token" }, transport,
  });

  await expect(adapter.complete("gemini-flash", {})).rejects.toThrow("Vertex AI returned HTTP 403");
  expect(transport.mock.calls[0]?.[1]?.redirect).toBe("error");
});
