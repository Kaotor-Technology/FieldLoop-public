import { describe, expect, it, vi } from "vitest";
import { cancelAgentTurn, consumeAgentEvents, createAgentSession, streamAgentMessage } from "./agent-chat-client";
import { buildAgentContextChips, contextualizeAgentMessage, removeAgentContextSearch } from "./agent-chat-context";

describe("agent chat transport", () => {
  it("creates a same-origin session with the CSRF token and no browser bearer token", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: "session-synthetic", agent: "integrity-orchestrator", simulated: true, classification: "INTERNAL",
    }), { status: 201, headers: { "content-type": "application/json" } }));

    await createAgentSession("integrity-orchestrator", "csrf-fixture", fetcher);

    const firstCall = fetcher.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [url, init] = firstCall ?? ["", undefined];
    expect(url).toBe("/api/v1/assistant/sessions");
    expect(init?.credentials).toBe("same-origin");
    expect(new Headers(init?.headers).get("x-csrf-token")).toBe("csrf-fixture");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(new Headers(init?.headers).has("x-fieldloop-internal-user-token")).toBe(false);
  });

  it("parses SSE events split across chunks and preserves UTF-8 text", async () => {
    const bytes = new TextEncoder().encode(
      "id: 4\nevent: agent.step\ndata: {\"phase\":\"start\"}\n\n" +
      "id: 5\nevent: answer.final\ndata: {\"answer\":\"ภาษาไทย\",\"citations\":[\"DOC-1\"]}\n\n",
    );
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 49));
        controller.enqueue(bytes.slice(49, 52));
        controller.enqueue(bytes.slice(52));
        controller.close();
      },
    }), { headers: { "content-type": "text/event-stream" } });
    const events: Array<{ name: string; id?: string; data: Record<string, unknown> }> = [];

    await consumeAgentEvents(response, (event) => events.push(event));

    expect(events).toEqual([
      { name: "agent.step", id: "4", data: { phase: "start" } },
      { name: "answer.final", id: "5", data: { answer: "ภาษาไทย", citations: ["DOC-1"] } },
    ]);
  });

  it("uses the expected message and cancellation endpoints", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("event: answer.final\ndata: {\"answer\":\"Done\"}\n\n", {
        headers: { "content-type": "text/event-stream" },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const events: string[] = [];

    await streamAgentMessage("session/id", "Question", "csrf", (event) => events.push(event.name), fetcher);
    await cancelAgentTurn("session/id", "csrf", fetcher);

    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/assistant/sessions/session%2Fid/messages");
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/v1/assistant/sessions/session%2Fid:cancel");
    expect(events).toEqual(["answer.final"]);
  });
});

describe("agent context", () => {
  const translate = (key: string) => key;

  it("builds removable context from URL state and puts the same values in the message", () => {
    const search = {
      agentFeatureId: "asset-synthetic-1",
      agentFeatureName: "Synthetic Segment",
      agentFeatureKind: "segment",
      agentChainageFrom: 40,
      agentChainageTo: 65,
      incidentId: "incident-synthetic-1",
      scenarioId: "storm-synthetic-1",
      bbox: "100.1,13.1,100.5,13.5",
    };
    const chips = buildAgentContextChips(search, translate);

    expect(chips.map(({ key }) => key)).toEqual(["feature", "chainage", "incident", "scenario", "map-area"]);
    expect(contextualizeAgentMessage("Check this", chips)).toContain("KP 40–65");
    expect(contextualizeAgentMessage("Check this", chips)).toContain("incident-synthetic-1");
    const chainageChip = chips.find(({ key }) => key === "chainage");
    expect(chainageChip).toBeDefined();
    if (!chainageChip) throw new Error("Chainage chip should be created from the fixture");
    expect(removeAgentContextSearch(search, chainageChip)).not.toHaveProperty("agentChainageFrom");
  });

  it("ignores malformed map bounds and empty search values", () => {
    expect(buildAgentContextChips({ bbox: "north,west", scenario: " " }, translate)).toEqual([]);
  });
});
