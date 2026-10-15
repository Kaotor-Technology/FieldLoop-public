import { create } from "zustand";
import type { AgentSession, AgentStreamEvent } from "./agent-chat-client";

export type AgentTurnStatus = "running" | "complete" | "incomplete" | "error";
export type AgentStepStatus = "running" | "done" | "blocked" | "failed";

export interface AgentAnswer {
  answer: string;
  citations: unknown[];
  retrievedCitations: unknown[];
  known: unknown[];
  unknown: unknown[];
  assumptions: unknown[];
  confidence: string;
  confidenceReason: string;
  actionRequestIds: string[];
  incomplete?: string;
}

export interface AgentTurn {
  id: string;
  prompt: string;
  message: string;
  agentId: string;
  simulated: boolean;
  classification: string;
  steps: Array<AgentStreamEvent & { stepId: string; status: AgentStepStatus }>;
  partialAnswer: string;
  answer?: AgentAnswer;
  status: AgentTurnStatus;
  error?: string;
}

interface AgentChatState {
  session: AgentSession | null;
  sessionsByAgent: Record<string, AgentSession>;
  turns: AgentTurn[];
  draft: string;
  activeTurnId: string | null;
  isRunning: boolean;
  streamConnected: boolean;
  cancelPending: boolean;
  selectedCitation: string | null;
  setSession: (session: AgentSession) => void;
  setDraft: (draft: string) => void;
  clearDraft: () => void;
  setSelectedCitation: (citation: string | null) => void;
  addTurn: (prompt: string, message: string, agentId: string) => string;
  setTurnSession: (turnId: string, session: AgentSession) => void;
  retryTurn: (turnId: string) => void;
  appendEvent: (turnId: string, event: AgentStreamEvent) => void;
  appendPartialAnswer: (turnId: string, text: string) => void;
  finishTurn: (turnId: string, answer: AgentAnswer, incomplete: boolean) => void;
  failTurn: (turnId: string, error: string) => void;
  setStreamConnected: (connected: boolean) => void;
  requestCancel: () => void;
  takeCancelRequest: () => boolean;
}

export const useAgentChatStore = create<AgentChatState>((set, get) => ({
  session: null,
  sessionsByAgent: {},
  turns: [],
  draft: "",
  activeTurnId: null,
  isRunning: false,
  streamConnected: false,
  cancelPending: false,
  selectedCitation: null,
  setSession: (session) => set((state) => ({ session, sessionsByAgent: { ...state.sessionsByAgent, [session.agent]: session } })),
  setDraft: (draft) => set({ draft }),
  clearDraft: () => set({ draft: "" }),
  setSelectedCitation: (selectedCitation) => set({ selectedCitation }),
  addTurn: (prompt, message, agentId) => {
    const id = createId();
    const turn: AgentTurn = { id, prompt, message, agentId, simulated: false, classification: "INTERNAL", steps: [], partialAnswer: "", status: "running" };
    set((state) => ({ turns: [...state.turns, turn], activeTurnId: id, isRunning: true, streamConnected: false, cancelPending: false }));
    return id;
  },
  setTurnSession: (turnId, session) => set((state) => ({
    turns: state.turns.map((turn) => turn.id === turnId
      ? { ...turn, simulated: session.simulated, classification: session.classification }
      : turn),
  })),
  retryTurn: (turnId) => set((state) => ({
    turns: state.turns.map((turn) => {
      if (turn.id !== turnId) return turn;
      const retry = { ...turn };
      delete retry.answer;
      delete retry.error;
      return { ...retry, partialAnswer: "", status: "running" };
    }),
    activeTurnId: turnId,
    isRunning: true,
    streamConnected: false,
    cancelPending: false,
  })),
  appendEvent: (turnId, event) => set((state) => ({
    turns: state.turns.map((turn) => {
      if (turn.id !== turnId) return turn;
      const steps = [...turn.steps];
      if (event.name === "tool.result") {
        const toolName = readText(event.data["tool"]);
        let index = steps.length - 1;
        while (index >= 0) {
          const step = steps[index];
          if (step?.name === "tool.call" && step.status === "running" && (!toolName || step.data["tool"] === toolName)) {
            steps[index] = { ...step, status: "done" };
            break;
          }
          index -= 1;
        }
      }
      const decision = readText(event.data["decision"]) ?? readText(event.data["action"]);
      const blocked = event.name === "guardrail.decision" && ["block", "blocked", "hold"].includes(decision?.toLowerCase() ?? "");
      const status: AgentStepStatus = event.name === "tool.call" ? "running" : blocked ? "blocked" : "done";
      steps.push({ ...event, stepId: createId(), status });
      return { ...turn, steps };
    }),
  })),
  appendPartialAnswer: (turnId, text) => set((state) => ({
    turns: state.turns.map((turn) => turn.id === turnId ? { ...turn, partialAnswer: turn.partialAnswer + text } : turn),
  })),
  finishTurn: (turnId, answer, incomplete) => set((state) => ({
    turns: state.turns.map((turn) => turn.id === turnId
      ? { ...turn, answer, partialAnswer: "", status: incomplete ? "incomplete" : "complete", steps: turn.steps.map((step) => step.status === "running" ? { ...step, status: "done" } : step) }
      : turn),
    activeTurnId: state.activeTurnId === turnId ? null : state.activeTurnId,
    isRunning: state.activeTurnId === turnId ? false : state.isRunning,
    streamConnected: false,
    cancelPending: false,
  })),
  failTurn: (turnId, error) => set((state) => ({
    turns: state.turns.map((turn) => turn.id === turnId ? { ...turn, status: "error", error, steps: turn.steps.map((step) => step.status === "running" ? { ...step, status: "failed" } : step) } : turn),
    activeTurnId: state.activeTurnId === turnId ? null : state.activeTurnId,
    isRunning: state.activeTurnId === turnId ? false : state.isRunning,
    streamConnected: false,
    cancelPending: false,
  })),
  setStreamConnected: (streamConnected) => set({ streamConnected }),
  requestCancel: () => set({ cancelPending: true }),
  takeCancelRequest: () => {
    const pending = get().cancelPending;
    if (pending) set({ cancelPending: false });
    return pending;
  },
}));

function createId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : String(Date.now()) + String(Math.random()).slice(2);
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
