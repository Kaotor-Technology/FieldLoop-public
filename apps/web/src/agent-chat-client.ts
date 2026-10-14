export interface AgentSession {
  id: string;
  agent: string;
  simulated: boolean;
  classification: string;
}

export interface AgentStreamEvent {
  name: string;
  data: Record<string, unknown>;
  id?: string;
}

export class AgentChatRequestError extends Error {
  constructor(readonly status: number) {
    super("Agent Chat request failed");
    this.name = "AgentChatRequestError";
  }
}

const sessionPath = "/api/assistant/v1/sessions";

export async function createAgentSession(
  agent: string,
  csrfToken: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<AgentSession> {
  const response = await fetcher(sessionPath, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify({ agent }),
  });
  if (!response.ok) throw new AgentChatRequestError(response.status);
  const value: unknown = await response.json();
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.agent !== "string") {
    throw new AgentChatRequestError(502);
  }
  return {
    id: value.id,
    agent: value.agent,
    simulated: value.simulated === true,
    classification: typeof value.classification === "string" ? value.classification : "INTERNAL",
  };
}

export async function streamAgentMessage(
  sessionId: string,
  message: string,
  csrfToken: string,
  onEvent: (event: AgentStreamEvent) => void,
  fetcher: typeof fetch = globalThis.fetch,
  onConnected?: () => void,
): Promise<void> {
  const response = await fetcher(sessionPath + "/" + encodeURIComponent(sessionId) + "/messages", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify({ message }),
  });
  if (!response.ok) throw new AgentChatRequestError(response.status);
  onConnected?.();
  await consumeAgentEvents(response, onEvent);
}

export async function cancelAgentTurn(
  sessionId: string,
  csrfToken: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<void> {
  const response = await fetcher(sessionPath + "/" + encodeURIComponent(sessionId) + ":cancel", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { accept: "application/json", "x-csrf-token": csrfToken },
  });
  if (!response.ok) throw new AgentChatRequestError(response.status);
}

export async function consumeAgentEvents(
  response: Response,
  onEvent: (event: AgentStreamEvent) => void,
): Promise<void> {
  if (!response.ok) throw new AgentChatRequestError(response.status);
  if (!response.body) throw new AgentChatRequestError(502);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let eventId: string | undefined;
  let dataLines: string[] = [];

  const dispatch = () => {
    if (dataLines.length === 0) {
      eventName = "";
      eventId = undefined;
      return;
    }
    const rawData = dataLines.join("\n");
    let value: unknown;
    try {
      value = JSON.parse(rawData);
    } catch {
      throw new AgentChatRequestError(502);
    }
    if (!isRecord(value)) throw new AgentChatRequestError(502);
    onEvent({ name: eventName || "message", data: value, ...(eventId ? { id: eventId } : {}) });
    eventName = "";
    eventId = undefined;
    dataLines = [];
  };

  const processLine = (rawLine: string) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const rawValue = separator < 0 ? "" : line.slice(separator + 1);
    const fieldValue = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "event") eventName = fieldValue;
    else if (field === "data") dataLines.push(fieldValue);
    else if (field === "id" && !fieldValue.includes("\u0000")) eventId = fieldValue;
  };

  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        processLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
      if (chunk.done) break;
    }
    if (buffer.length > 0) processLine(buffer);
    dispatch();
  } finally {
    reader.releaseLock();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
