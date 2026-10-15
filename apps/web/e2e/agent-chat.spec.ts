import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { expectThaiTypography } from "./thai-typography";

const citedAnswer = "The synthetic Code & Standard catalogue lists the CP survey interval for the selected segment.";

test.beforeEach(async ({ page, request }) => {
  await request.get("/test/reset");
  await page.addInitScript(() => {
    const mockWindow = window as Window & {
      __agentController?: ReadableStreamDefaultController<Uint8Array>;
      __fieldLoopEmit?: (name: string, data: Record<string, unknown>) => void;
      __fieldLoopEventSourceCount?: () => number;
    };
    const eventChunk = (name: string, data: Record<string, unknown>) => new TextEncoder().encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    class TestEventSource extends EventTarget {
      static readonly instances = new Set<TestEventSource>();
      onopen: ((this: EventSource, event: Event) => unknown) | null = null;
      onerror: ((this: EventSource, event: Event) => unknown) | null = null;
      constructor(readonly url: string) {
        super();
        TestEventSource.instances.add(this);
        queueMicrotask(() => this.onopen?.call(this as unknown as EventSource, new Event("open")));
      }
      close() { TestEventSource.instances.delete(this); }
      emit(name: string, data: Record<string, unknown>) {
        this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) }));
      }
    }
    Object.defineProperty(window, "EventSource", { configurable: true, value: TestEventSource });
    mockWindow.__fieldLoopEmit = (name, data) => {
      for (const stream of TestEventSource.instances) stream.emit(name, data);
    };
    mockWindow.__fieldLoopEventSourceCount = () => TestEventSource.instances.size;
    if (!sessionStorage.getItem("__agentRequests")) sessionStorage.setItem("__agentRequests", "[]");
    if (!sessionStorage.getItem("__agentMode")) sessionStorage.setItem("__agentMode", "normal");
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const inputUrl = input instanceof Request ? input.url : String(input);
      const url = new URL(inputUrl, window.location.href);
      if (!url.pathname.startsWith("/api/v1/assistant/")) return originalFetch(input, init);

      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
      const requests = JSON.parse(sessionStorage.getItem("__agentRequests") ?? "[]") as Array<Record<string, unknown>>;
      requests.push({ path: url.pathname, method, body, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      sessionStorage.setItem("__agentRequests", JSON.stringify(requests));

      if (url.pathname === "/api/v1/assistant/sessions" && method === "POST") {
        const requestedAgent = body !== null && typeof body === "object" && "agent" in body && typeof body.agent === "string" ? body.agent : "integrity-orchestrator";
        return new Response(JSON.stringify({ id: "session-synthetic-1-" + requestedAgent, agent: requestedAgent, simulated: true, classification: "INTERNAL" }), {
          status: 201, headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.endsWith(":cancel") && method === "POST") {
        mockWindow.__agentController?.enqueue(eventChunk("answer.incomplete", { answer: "Stopped before completion.", incomplete: "cancelled", citations: [], known: [], unknown: ["The remaining evidence"], assumptions: [], confidence: "low", confidence_reason: "The response was stopped." }));
        mockWindow.__agentController?.close();
        delete mockWindow.__agentController;
        return new Response(JSON.stringify({ cancelling: true }), { status: 202, headers: { "content-type": "application/json" } });
      }
      if (url.pathname.endsWith("/messages") && method === "POST") {
        const mode = sessionStorage.getItem("__agentMode");
        if (mode === "action" || mode === "held" || mode === "blocked") {
          const actionRequestId = "00000000-0000-4000-8000-000000000097";
          const decision = mode === "action" ? "convert_l1" : mode === "held" ? "hold_l2" : "block";
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(eventChunk("guardrail.decision", {
                decision,
                reason: mode === "action" ? "Converted to a human review request." : mode === "held" ? "Held for human review." : "The tool call was blocked.",
                policy_id: "SYNTHETIC-POLICY-1",
                ...(mode === "action" ? { action_request_id: actionRequestId } : mode === "held" ? { held_request_id: "synthetic-held-1" } : {}),
              }));
              controller.enqueue(eventChunk("answer.final", {
                answer: "The Guardrail decision is recorded.",
                citations: [], retrieved_citations: [], known: [], unknown: [], assumptions: [],
                confidence: "medium", confidence_reason: "Synthetic fixture.",
                action_request_ids: mode === "action" ? [actionRequestId] : [],
              }));
              controller.close();
            },
          }), { headers: { "content-type": "text/event-stream" } });
        }
        const messageRequests = requests.filter((request) => request.path === url.pathname).length;
        if (mode === "error-once" && messageRequests === 1) {
          return new Response(new ReadableStream<Uint8Array>({
            pull(controller) {
              if (controller.desiredSize === null) return;
              const count = Number(sessionStorage.getItem("__agentErrorChunks") ?? "0");
              if (count === 0) controller.enqueue(eventChunk("agent.step", { phase: "start" }));
              else if (count === 1) controller.enqueue(eventChunk("tool.call", { tool: "knowledge.search" }));
              else controller.error(new Error("Synthetic stream interruption"));
              sessionStorage.setItem("__agentErrorChunks", String(count + 1));
            },
          }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
        }
        if (mode === "hold") {
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              mockWindow.__agentController = controller;
              controller.enqueue(eventChunk("agent.step", { phase: "start" }));
            },
          }), { headers: { "content-type": "text/event-stream" } });
        }
        if (mode === "limit") {
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(eventChunk("agent.step", { phase: "start" }));
              controller.enqueue(eventChunk("answer.incomplete", {
                answer: "The synthetic catalogue does not specify the route survey interval yet.",
                incomplete: "tool_calls", citations: [{ id: "DOC-SYNTHETIC-CP-01", title: "Synthetic CP Survey Guidance", revision: "R2" }],
                retrieved_citations: [{ id: "DOC-SYNTHETIC-CP-01", title: "Synthetic CP Survey Guidance", revision: "R2" }],
                known: ["The synthetic catalogue contains CP survey guidance."],
                unknown: ["The route measurement basis and survey history are missing."],
                assumptions: [], confidence: "low", confidence_reason: "The route-specific evidence is incomplete.",
              }));
              controller.close();
            },
          }), { headers: { "content-type": "text/event-stream" } });
        }
        return new Response(new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(eventChunk("agent.step", { phase: "start" }));
            controller.enqueue(eventChunk("agent.step", { phase: "handoff", to: "code-standard" }));
            controller.enqueue(eventChunk("tool.call", { tool: "knowledge.search" }));
            controller.enqueue(eventChunk("tool.result", { tool: "knowledge.search", summary: "Found current synthetic evidence." }));
            controller.enqueue(eventChunk("guardrail.decision", { decision: "allow", policyId: "SYNTHETIC-POLICY-1" }));
            controller.enqueue(eventChunk("answer.partial", { delta: "Checking the synthetic Code & Standard catalogue. " }));
            if (mode === "slow") await new Promise((resolve) => setTimeout(resolve, 300));
            controller.enqueue(eventChunk("answer.final", {
              answer: "The synthetic Code & Standard catalogue lists the CP survey interval for the selected segment.",
              citations: mode === "reference" ? ["ASME B31.8 (edition not verified)"] : ["DOC-SYNTHETIC-CP-01"],
              retrieved_citations: [{ document_id: "DOC-SYNTHETIC-CP-01", title: "Synthetic CP Survey Guidance", revision: "R2", page: 4, clause: "5.1" }],
              known: ["The synthetic catalogue contains CP survey guidance."], unknown: ["The route measurement basis is not provided."], assumptions: ["The selected route maps to this catalogue entry."],
              confidence: "medium", confidence_reason: "One synthetic catalogue entry supports this answer.",
            }));
            controller.close();
          },
        }), { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ code: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });
    };
    const originalFetchForActions = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const inputUrl = input instanceof Request ? input.url : String(input);
      const url = new URL(inputUrl, window.location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (url.pathname === "/api/v1/action-requests/00000000-0000-4000-8000-000000000097" && method === "GET") {
        if (sessionStorage.getItem("__actionRequestStatus") === "unavailable") {
          return Response.json({ code: "service_unavailable" }, { status: 503 });
        }
        return Response.json({
          id: "00000000-0000-4000-8000-000000000097", orgId: "synthetic-org", actionType: "system_of_record",
          actionLevel: "l1", target: "cmms", payload: { title: "Synthetic work order" },
          payloadHash: "a".repeat(64), rationale: "Prepare for human review.", citations: ["synthetic:procedure-1"],
          requestedBy: "synthetic-operator", requester: { kind: "assistant", aiSystemId: "00000000-0000-4000-8000-000000000001" },
          status: sessionStorage.getItem("__actionRequestStatus") === "approved" ? "approved" : "open",
          expiresAt: "2026-10-15T13:00:00.000Z", simulated: true, classification: "INTERNAL",
        });
      }
      return originalFetchForActions(input, init);
    };
  });
  await page.goto("/map");
  await page.getByRole("link", { name: "Sign in as operator" }).click();
  await expect(page.getByRole("heading", { name: "Geo Command Map", exact: true })).toBeVisible();
});

async function setAgentMode(page: import("@playwright/test").Page, mode: "normal" | "hold" | "error-once" | "slow" | "limit" | "reference" | "action" | "held" | "blocked") {
  await page.evaluate((value) => sessionStorage.setItem("__agentMode", value), mode);
}

async function readAgentRequests(page: import("@playwright/test").Page): Promise<Array<{ path: string; method: string; body?: { agent?: string; message?: string }; headers: Record<string, string> }>> {
  return page.evaluate(() => JSON.parse(sessionStorage.getItem("__agentRequests") ?? "[]") as Array<{ path: string; method: string; body?: { agent?: string; message?: string }; headers: Record<string, string> }>);
}

test("workspace sends map context and presents the streamed trace, answer basis and citation details", async ({ page }) => {
  await setAgentMode(page, "slow");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/agent?agentFeatureId=synthetic-segment-01&agentFeatureName=Synthetic%20Segment&agentFeatureKind=segment&agentChainageFrom=40&agentChainageTo=65&incidentId=incident-synthetic-01&scenarioId=storm-synthetic-01&bbox=100.1%2C13.1%2C100.5%2C13.5");
  await expect(page.getByRole("heading", { name: "Agent Chat", exact: true })).toBeVisible();
  await expect(page.getByText("Synthetic Segment", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("KP 40–65", { exact: true })).toBeVisible();
  await expect(page.getByText("incident-synthetic-01", { exact: true })).toBeVisible();
  await expect(page.getByText("storm-synthetic-01", { exact: true })).toBeVisible();

  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("What CP survey interval applies to this segment?");
  await composer.press("Enter");
  const conversation = page.getByRole("log", { name: "Agent conversation" });
  await expect(conversation.getByText("Checking the synthetic Code & Standard catalogue.", { exact: false })).toBeVisible();
  await expect(conversation.getByText(citedAnswer, { exact: true })).toBeVisible();
  await expect(page.getByText("SIMULATION", { exact: true })).toBeVisible();
  await expect(page.getByText("Known", { exact: true })).toBeVisible();
  await expect(page.getByText("Unknown", { exact: true })).toBeVisible();
  await expect(page.getByText("Assumptions", { exact: true })).toBeVisible();
  await expect(page.getByText("Medium confidence", { exact: true })).toBeVisible();
  await expect(page.getByText("The agent could not approve", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Approve/ })).toHaveCount(0);
  const timeline = page.locator(".agent-chat-timeline");
  await expect(timeline).not.toHaveAttribute("open", "");
  await timeline.locator("summary").click();
  await expect(timeline).toContainText("Tool call");
  await expect(timeline).toContainText("Handed off to");
  await expect(timeline).toContainText("code-standard");
  await expect(timeline).toContainText("Guardrail decision");
  await expect(timeline).toContainText("Found current synthetic evidence.");
  await timeline.locator("summary").click();
  await expect(timeline).not.toHaveAttribute("open", "");

  const sources = page.getByRole("complementary", { name: "Cited sources" });
  await page.getByRole("button", { name: "Source 1: Synthetic CP Survey Guidance" }).click();
  await expect(sources).toContainText("Revision");
  await expect(sources).toContainText("R2");
  await expect(sources).toContainText("5.1");
  await expect(sources.locator("dd").filter({ hasText: /^4$/ })).toBeVisible();
  await expect(sources).not.toContainText(/licen[cs]e/i);

  const requests = await readAgentRequests(page);
  const create = requests.find((request) => request.path === "/api/v1/assistant/sessions");
  const message = requests.find((request) => request.path.endsWith("/messages"));
  expect(create?.body).toEqual({ agent: "integrity-orchestrator" });
  expect(message?.body?.message).toContain("synthetic-segment-01");
  expect(message?.body?.message).toContain("Synthetic Segment");
  expect(message?.body?.message).toContain("incident-synthetic-01");
  expect(message?.body?.message).toContain("What CP survey interval applies to this segment?");
  expect(message?.headers["x-csrf-token"]).toBeTruthy();
  expect(message?.headers.authorization).toBeUndefined();
  expect(message?.headers["x-fieldloop-internal-user-token"]).toBeUndefined();
  await page.screenshot({ path: "e2e/evidence/agent-chat-workspace.png", fullPage: true });
});

test("renders Action Request cards without chat approval and refreshes status from the Query cache after SSE", async ({ page }) => {
  const actionRequestId = "00000000-0000-4000-8000-000000000097";
  await setAgentMode(page, "action");
  await page.goto("/agent");
  await expect.poll(() => page.evaluate(() => {
    const target = window as Window & { __fieldLoopEventSourceCount?: () => number };
    return target.__fieldLoopEventSourceCount?.();
  })).toBe(1);
  await page.getByRole("textbox", { name: "Message" }).fill("Prepare the synthetic work order");
  await page.getByRole("button", { name: "Send" }).click();

  const card = page.locator(".agent-chat-artifact-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("L1");
  await expect(card).toContainText("SLA");
  await expect(card).toContainText("Open");
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeInViewport({ ratio: 0.8 });
  await page.screenshot({ path: "e2e/evidence/agent-chat-action-request.png", fullPage: true });
  const timeline = page.locator(".agent-chat-timeline");
  await timeline.locator("summary").click();
  await expect(timeline.locator(".agent-chat-guardrail-converted")).toContainText("SYNTHETIC-POLICY-1");
  const reviewLink = card.getByRole("link", { name: "Review and approve" });
  await expect(reviewLink).toHaveAttribute("href", `/actions/${actionRequestId}`);
  await expect(page.getByText("SYNTHETIC-POLICY-1", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);

  await page.evaluate((id) => {
    sessionStorage.setItem("__actionRequestStatus", "approved");
    const target = window as Window & { __fieldLoopEmit?: (name: string, data: Record<string, unknown>) => void };
    target.__fieldLoopEmit?.("action_request.updated", { id: "synthetic-event-id", entityId: id, status: "approved" });
  }, actionRequestId);
  await expect(card).toContainText("Approved");

  await reviewLink.click();
  await expect(page).toHaveURL(new RegExp(`/actions/${actionRequestId}$`));
  await expect(page.getByRole("heading", { name: actionRequestId })).toBeVisible();
  await page.getByRole("button", { name: "Review and approve" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("shows distinct held and blocked Guardrail notices with policy IDs", async ({ page }) => {
  for (const mode of ["held", "blocked"] as const) {
    await setAgentMode(page, mode);
    await page.goto("/agent");
    await page.getByRole("textbox", { name: "Message" }).fill("Check the synthetic action");
    await page.getByRole("button", { name: "Send" }).click();
    const timeline = page.locator(".agent-chat-timeline");
    await timeline.locator("summary").click();
    await expect(timeline.getByText("SYNTHETIC-POLICY-1", { exact: true })).toBeVisible();
    await expect(timeline.locator(mode === "held" ? ".agent-chat-guardrail-held" : ".agent-chat-guardrail-blocked")).toBeVisible();
    await expect(page.locator(".agent-chat-artifact-card")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  }
});

test("context chips remove only their own URL state", async ({ page }) => {
  await page.goto("/agent?agentFeatureId=synthetic-segment-01&agentFeatureName=Synthetic%20Segment&agentFeatureKind=segment&agentChainageFrom=40&agentChainageTo=65");
  await page.getByRole("button", { name: "Remove Chainage context" }).click();
  await expect(page).toHaveURL(/agentFeatureId=synthetic-segment-01/);
  await expect(page).not.toHaveURL(/agentChainageFrom/);
  await expect(page.getByText("Synthetic Segment", { exact: false }).first()).toBeVisible();
});

test("Shift+Enter inserts a line and Enter during IME composition does not send", async ({ page }) => {
  await page.goto("/agent");
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("Line one");
  await composer.press("Shift+Enter");
  await composer.type("Line two");
  await expect(composer).toHaveValue("Line one\nLine two");
  await composer.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "ไ" }));
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, which: 229, bubbles: true, cancelable: true, isComposing: true }));
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "ไ" }));
  });
  expect((await readAgentRequests(page)).filter((request) => request.path.endsWith("/messages"))).toHaveLength(0);
  await composer.press("Enter");
  await expect(page.getByRole("log", { name: "Agent conversation" }).getByText(citedAnswer, { exact: true })).toBeVisible();
  const requests = await readAgentRequests(page);
  const message = requests.find((request) => request.path.endsWith("/messages"));
  expect(message?.body?.message).toContain("Line one\nLine two");
});

test("Stop cancels the running turn and shows the incomplete state", async ({ page }) => {
  await setAgentMode(page, "hold");
  await page.goto("/agent");
  await page.getByRole("textbox", { name: "Message" }).fill("Check the evidence");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByText("Incomplete.", { exact: false })).toBeVisible();
  await expect(page.getByText("The turn was stopped before the answer was complete.")).toBeVisible();
  const cancel = (await readAgentRequests(page)).find((request) => request.path.endsWith(":cancel"));
  expect(cancel?.method).toBe("POST");
  expect(cancel?.headers["x-csrf-token"]).toBeTruthy();
});

test("a turn limit shows an Incomplete answer and the evidence still needed", async ({ page }) => {
  await setAgentMode(page, "limit");
  await page.goto("/agent");
  await page.getByRole("textbox", { name: "Message" }).fill("What CP survey interval applies?");
  await page.getByRole("button", { name: "Send" }).click();
  const conversation = page.getByRole("log", { name: "Agent conversation" });
  await expect(conversation).toContainText("Incomplete.");
  await expect(conversation).toContainText("The tool-call limit was reached.");
  await expect(conversation).toContainText("The route measurement basis and survey history are missing.");
});

test("a broken stream retains its trace and Retry can finish the turn", async ({ page }) => {
  await setAgentMode(page, "error-once");
  await page.goto("/agent");
  await page.getByRole("textbox", { name: "Message" }).fill("Try the evidence lookup");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("alert")).toContainText("visible steps are retained");
  await expect(page.locator(".agent-chat-timeline")).toContainText("knowledge.search");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("log", { name: "Agent conversation" }).getByText(citedAnswer, { exact: true })).toBeVisible();
  await expect(page.locator(".agent-chat-timeline")).toContainText("knowledge.search");
  expect((await readAgentRequests(page)).filter((request) => request.path.endsWith("/messages"))).toHaveLength(2);
});

test("map context panel opens Agent and carries selected feature state into the full workspace", async ({ page }) => {
  await page.goto("/map?agentFeatureId=synthetic-segment-01&agentFeatureName=Synthetic%20Segment&agentFeatureKind=segment&agentChainageFrom=40&agentChainageTo=65");
  const panel = page.getByRole("complementary", { name: "Map context panel" });
  await panel.getByRole("tab", { name: "Agent" }).click();
  await expect(panel.getByRole("textbox", { name: "Message" })).toBeVisible();
  await expect(panel.getByText("Synthetic Segment", { exact: false }).first()).toBeVisible();
  await panel.getByRole("link", { name: "Open full workspace" }).click();
  await expect(page).toHaveURL(/\/agent\?.*agentFeatureId=synthetic-segment-01/);
  await expect(page.getByText("KP 40–65", { exact: true })).toBeVisible();
});

test("the selected map story carries its matching Agent into the full workspace", async ({ page }) => {
  await page.getByRole("button", { name: "Bangkok flood", exact: true }).click();
  await expect(page).toHaveURL(/domain=flood-water/);
  const panel = page.getByRole("complementary", { name: "Map context panel" });
  await panel.getByRole("tab", { name: "Agent" }).click();
  await panel.getByRole("link", { name: "Open full workspace" }).click();
  await expect(page).toHaveURL(/\/agent\?.*domain=flood-water/);
  await expect(page.getByRole("heading", { name: "Flood Situation" })).toBeVisible();
  await page.getByRole("textbox", { name: "Message" }).fill("What is the current flood context?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("log", { name: "Agent conversation" }).getByRole("heading", { name: "Flood Situation" })).toBeVisible();
  expect((await readAgentRequests(page)).find((request) => request.path === "/api/v1/assistant/sessions")?.body).toEqual({ agent: "flood-situation" });
});

for (const route of ["workspace", "docked"] as const) {
  for (const theme of ["light", "dark"] as const) {
    for (const width of [390, 1280]) {
      test(`Agent Chat ${route} has no axe violations in ${theme} at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        if (theme === "dark") await page.getByRole("button", { name: "Night shift" }).click();
        if (route === "workspace") await page.goto("/agent");
        else {
          await page.getByRole("tab", { name: "Agent" }).click();
          await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
        }
        const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
        expect(axe.violations).toEqual([]);
        if (theme === "light" && width === 390) {
          const targets = await page.locator(".agent-chat button, .agent-chat-workspace-link, .agent-workspace-heading a, .agent-chat-timeline summary").evaluateAll((elements) => elements.map((element) => {
            const bounds = element.getBoundingClientRect();
            return { width: bounds.width, height: bounds.height };
          }));
          expect(targets.every(({ width: targetWidth, height }) => targetWidth >= 44 && height >= 44)).toBe(true);
        }
      });
    }
  }
}

test("Thai Agent Chat meets typography rules and reflows at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("/agent");
  await page.getByRole("button", { name: "ภาษาไทย", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "th");
  await expectThaiTypography(page);
  const layout = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
  expect(layout.width).toBeLessThanOrEqual(layout.viewport);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(axe.violations).toEqual([]);
});


test("unlicensed standards show a reference-only source warning", async ({ page }) => {
  await setAgentMode(page, "reference");
  await page.goto("/agent");
  await page.getByRole("textbox", { name: "Message" }).fill("Which standard should I verify?");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Source 1: ASME B31.8 (edition not verified)" }).click();
  await expect(page.getByRole("complementary", { name: "Cited sources" }))
    .toContainText("Reference only — not verified against source text");
});
