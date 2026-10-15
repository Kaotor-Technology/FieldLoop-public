import { useId, useRef } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@fieldloop/ui";
import { useTranslation } from "react-i18next";
import { cancelAgentTurn, createAgentSession, streamAgentMessage } from "./agent-chat-client";
import type { AgentStreamEvent } from "./agent-chat-client";
import { contextualizeAgentMessage } from "./agent-chat-context";
import type { AgentContextChip } from "./agent-chat-context";
import { useAgentChatStore } from "./agent-chat-store";
import type { AgentAnswer, AgentTurn } from "./agent-chat-store";
import { useCurrentSession } from "./SessionGate";

export interface AgentChatProps {
  variant: "docked" | "workspace";
  contextChips: readonly AgentContextChip[];
  onRemoveContext: (chip: AgentContextChip) => void;
  agentId?: string;
  workspaceSearch?: Record<string, unknown>;
}

interface CitationView {
  key: string;
  id: string;
  title: string;
  revision?: string;
  page?: string;
  clause?: string;
}

export function AgentChat({
  variant,
  contextChips,
  onRemoveContext,
  agentId = "integrity-orchestrator",
  workspaceSearch,
}: AgentChatProps) {
  const { t, i18n } = useTranslation();
  const session = useCurrentSession();
  const textareaId = useId();
  const hintId = useId();
  const composing = useRef(false);
  const turns = useAgentChatStore((state) => state.turns);
  const draft = useAgentChatStore((state) => state.draft);
  const isRunning = useAgentChatStore((state) => state.isRunning);
  const activeTurnId = useAgentChatStore((state) => state.activeTurnId);
  const selectedCitation = useAgentChatStore((state) => state.selectedCitation);
  const setDraft = useAgentChatStore((state) => state.setDraft);
  const setSession = useAgentChatStore((state) => state.setSession);
  const setTurnSession = useAgentChatStore((state) => state.setTurnSession);
  const clearDraft = useAgentChatStore((state) => state.clearDraft);
  const addTurn = useAgentChatStore((state) => state.addTurn);
  const retryTurn = useAgentChatStore((state) => state.retryTurn);
  const appendEvent = useAgentChatStore((state) => state.appendEvent);
  const appendPartialAnswer = useAgentChatStore((state) => state.appendPartialAnswer);
  const finishTurn = useAgentChatStore((state) => state.finishTurn);
  const failTurn = useAgentChatStore((state) => state.failTurn);
  const setStreamConnected = useAgentChatStore((state) => state.setStreamConnected);
  const requestCancel = useAgentChatStore((state) => state.requestCancel);
  const takeCancelRequest = useAgentChatStore((state) => state.takeCancelRequest);
  const setSelectedCitation = useAgentChatStore((state) => state.setSelectedCitation);
  const language = i18n.resolvedLanguage ?? "en";
  const agentName = agentId === "flood-situation" ? t("agentNameFlood") : t("agentNameIntegrity");
  const allCitations = turns.flatMap((turn) => turn.answer ? normalizeCitations(turn.answer, turn.id) : []);
  const activeSource = allCitations.find((citation) => citation.key === selectedCitation);

  const startTurn = async (turnId: string, message: string, turnAgentId: string) => {
    const csrfToken = session.data?.csrfToken;
    if (!csrfToken) {
      failTurn(turnId, t("agentRequestFailed"));
      return;
    }

    try {
      let currentSession = useAgentChatStore.getState().sessionsByAgent[turnAgentId];
      if (!currentSession) currentSession = await createAgentSession(turnAgentId, csrfToken);
      setSession(currentSession);
      setTurnSession(turnId, currentSession);
      await streamAgentMessage(
        currentSession.id,
        message,
        csrfToken,
        (event) => handleAgentEvent(turnId, event),
        undefined,
        () => {
          setStreamConnected(true);
          if (takeCancelRequest()) void requestServerCancellation(currentSession.id, csrfToken, turnId);
        },
      );
      const currentTurn = useAgentChatStore.getState().turns.find((turn) => turn.id === turnId);
      if (currentTurn?.status === "running") failTurn(turnId, t("agentStreamEnded"));
    } catch {
      failTurn(turnId, t("agentRequestFailed"));
    }
  };

  const handleSubmit = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (isRunning || !draft.trim()) return;
    const prompt = draft.trim();
    clearDraft();
    const message = contextualizeAgentMessage(prompt, contextChips);
    const turnId = addTurn(prompt, message, agentId);
    void startTurn(turnId, message, agentId);
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    const nativeEvent = event.nativeEvent;
    if (composing.current || nativeEvent.isComposing || nativeEvent.keyCode === 229) return;
    event.preventDefault();
    handleSubmit();
  };

  const handleStop = () => {
    const state = useAgentChatStore.getState();
    if (!state.isRunning) return;
    requestCancel();
    const current = useAgentChatStore.getState();
    if (current.session && current.streamConnected && takeCancelRequest()) {
      void requestServerCancellation(current.session.id, session.data?.csrfToken ?? "", activeTurnId ?? "");
    }
  };

  const handleRetry = (turn: AgentTurn) => {
    retryTurn(turn.id);
    void startTurn(turn.id, turn.message, turn.agentId);
  };

  const renderCitation = (citation: CitationView, index: number) => <button
    key={citation.key}
    type="button"
    className="agent-chat-citation"
    aria-label={t("agentCitationAccessible", { number: index + 1, title: citation.title })}
    aria-pressed={selectedCitation === citation.key}
    onClick={() => setSelectedCitation(citation.key)}
  >
    <span className="mono">{index + 1}</span>
    <span>{renderMonoInline(citation.title)}</span>
  </button>;

  const renderSourceDetails = (citation: CitationView | undefined) => citation ? <div className="agent-chat-source-details">
    <h3>{citation.title}</h3>
    <dl>
      <dt>{t("agentSourceReference")}</dt><dd className="mono">{citation.id}</dd>
      {citation.revision ? <><dt>{t("agentSourceRevision")}</dt><dd className="mono">{citation.revision}</dd></> : null}
      {citation.page ? <><dt>{t("agentSourcePage")}</dt><dd className="mono">{citation.page}</dd></> : null}
      {citation.clause ? <><dt>{t("agentSourceClause")}</dt><dd className="mono">{citation.clause}</dd></> : null}
    </dl>
  </div> : <p className="agent-chat-muted">{t("agentSourceChoose")}</p>;

  return <section className={"agent-chat agent-chat-" + variant} aria-label={t("agentWorkspace")}>
    <div className="agent-chat-conversation">
      <div className="agent-chat-messages" role="log" aria-label={t("agentConversation")} aria-live="off" aria-relevant="additions" tabIndex={0}>
        {turns.length === 0 ? <div className="agent-chat-empty">
          <div className="agent-chat-avatar" aria-hidden="true">AG</div>
          <h2>{agentName}</h2>
          <p>{t("agentEmptyState")}</p>
        </div> : null}
        {turns.map((turn) => {
          const citations = turn.answer ? normalizeCitations(turn.answer, turn.id) : [];
          const isActive = isRunning && activeTurnId === turn.id;
          const turnAgentName = turn.agentId === "flood-situation" ? t("agentNameFlood") : t("agentNameIntegrity");
          return <article className="agent-chat-turn" key={turn.id}>
            <div className="agent-chat-user-message"><p lang={language}>{renderMonoInline(turn.prompt)}</p></div>
            <header className="agent-chat-agent-heading">
              <span className="agent-chat-avatar" aria-hidden="true">AG</span>
              <div><h3>{turnAgentName}</h3><p>{t("agentOnBehalf")}</p></div>
              {turn.simulated ? <span className="agent-chat-tag agent-chat-tag-simulation">SIMULATION</span> : null}
              {!turn.simulated ? <span className="agent-chat-tag">{turn.classification}</span> : null}
            </header>

            {turn.steps.length > 0 ? <details className="agent-chat-timeline" open={turn.status === "running"}>
              <summary>
                {isActive ? <span>{t("agentWorkInProgress")}</span> : <span><span className="mono">{turn.steps.length}</span> {t("agentSteps")} · <span className="mono">{citations.length}</span> {t("agentSources")}</span>}
              </summary>
              <ol>{turn.steps.map((step) => <li key={step.stepId} className="agent-chat-step">
                <div className="agent-chat-step-copy">{renderStep(step, t)}</div>
                <span className={"agent-chat-step-status agent-chat-step-status-" + step.status}>{t("agentStepStatus." + step.status)}</span>
              </li>)}</ol>
            </details> : null}

            <div className="agent-chat-answer" lang={language}>
              {turn.answer ? <p className="agent-chat-answer-copy">{renderMonoInline(turn.answer.answer)}</p> : null}
              {!turn.answer && turn.partialAnswer ? <p className="agent-chat-answer-copy">{renderMonoInline(turn.partialAnswer)}</p> : null}
              {turn.answer ? <>
                {citations.length > 0 ? <div className="agent-chat-citations" aria-label={t("agentCitations")}>{citations.map(renderCitation)}</div> : <p className="agent-chat-unverified">{t("agentJudgementUnverified")}</p>}
                <section className="agent-chat-known" aria-label={t("agentAnswerBasis")}>
                  <KnownList title={t("agentKnown")} values={turn.answer.known} />
                  <KnownList title={t("agentUnknown")} values={turn.answer.unknown} />
                  <KnownList title={t("agentAssumptions")} values={turn.answer.assumptions} />
                </section>
                <p className="agent-chat-confidence"><strong>{t("agentConfidenceLevel." + confidenceKey(turn.answer.confidence))}</strong><span> · </span>{renderMonoInline(turn.answer.confidenceReason || t("agentConfidenceReasonMissing"))}</p>
              </> : null}
              {turn.status === "incomplete" ? <p className="agent-chat-incomplete"><strong>{t("agentIncomplete")}</strong> {incompleteReason(turn.answer?.incomplete, t)}</p> : null}
              {turn.status === "error" ? <div className="agent-chat-error" role="alert">
                <p>{turn.error ?? t("agentRequestFailed")}</p>
                <Button type="button" variant="secondary" onClick={() => handleRetry(turn)}>{t("agentRetry")}</Button>
              </div> : null}
              {isActive && !turn.answer && !turn.partialAnswer ? <p className="agent-chat-streaming">{t("agentWaitingForAnswer")}</p> : null}
            </div>
          </article>;
        })}
      </div>

      <div className="agent-chat-announcements" aria-live="polite" aria-atomic="true">
        {turns.filter((turn) => turn.status === "complete" || turn.status === "incomplete").map((turn) => <p key={turn.id}>{turn.answer?.answer}</p>)}
      </div>

      <form className="agent-chat-composer" onSubmit={handleSubmit}>
        {contextChips.length > 0 ? <div className="agent-chat-context" aria-label={t("agentContextLabel")}>
          {contextChips.map((chip) => <div className="agent-chat-context-chip" key={chip.key}>
            <span>{chip.label}</span><span className="mono">{chip.value}</span>
            <button type="button" aria-label={t("agentRemoveContext", { label: chip.label })} onClick={() => onRemoveContext(chip)}>×</button>
          </div>)}
        </div> : null}
        <label className="agent-chat-message-label" htmlFor={textareaId}>{t("agentMessageLabel")}</label>
        <textarea
          id={textareaId}
          value={draft}
          lang={language}
          rows={3}
          aria-describedby={hintId}
          placeholder={t("agentMessagePlaceholder")}
          disabled={isRunning}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={handleComposerKeyDown}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
        />
        <div className="agent-chat-composer-footer">
          <p className="agent-chat-key-hint" id={hintId}>{t("agentKeyHint")}</p>
          <div className="agent-chat-actions">
            {variant === "docked" ? <Link className="agent-chat-workspace-link" to="/agent" search={() => workspaceSearch ?? {}}>{t("openAgentWorkspace")}</Link> : null}
            {isRunning ? <Button type="button" variant="secondary" onClick={handleStop}>{t("agentStop")}</Button> : <Button type="submit" variant="primary" disabled={!draft.trim()}>{t("agentSend")}</Button>}
          </div>
        </div>
      </form>
    </div>

    {variant === "workspace" ? <aside className="agent-chat-sources" aria-label={t("agentSourcesPane")}>
      <h2>{t("agentCitedSources")}</h2>
      {activeSource ? renderSourceDetails(activeSource) : <p className="agent-chat-muted">{t("agentSourceChoose")}</p>}
      {allCitations.length > 0 ? <ul>{allCitations.map((citation) => <li key={citation.key}>
        <button type="button" aria-pressed={selectedCitation === citation.key} onClick={() => setSelectedCitation(citation.key)}>
          <span>{citation.title}</span>{citation.revision ? <span className="mono">{citation.revision}</span> : null}
        </button>
      </li>)}</ul> : null}
    </aside> : selectedCitation ? <aside className="agent-chat-inline-source" aria-label={t("agentSourcesPane")}>
      <button type="button" aria-label={t("agentCloseSource")} onClick={() => setSelectedCitation(null)}>×</button>
      {renderSourceDetails(activeSource)}
    </aside> : null}
  </section>;

  function handleAgentEvent(turnId: string, event: AgentStreamEvent) {
    if (event.name === "answer.partial" || event.name === "answer.delta") {
      const delta = readString(event.data["delta"]) ?? readString(event.data["text"]);
      if (delta) appendPartialAnswer(turnId, delta);
      return;
    }
    if (event.name === "answer.final" || event.name === "answer.incomplete") {
      const answer = normalizeAnswer(event.data);
      finishTurn(turnId, answer, event.name === "answer.incomplete" || Boolean(answer.incomplete));
      return;
    }
    if (event.name === "answer.error") {
      failTurn(turnId, t("agentRequestFailed"));
      return;
    }
    appendEvent(turnId, event);
  }

  async function requestServerCancellation(sessionId: string, csrfToken: string, turnId: string) {
    try {
      await cancelAgentTurn(sessionId, csrfToken);
    } catch {
      failTurn(turnId, t("agentCancelFailed"));
    }
  }
}

function KnownList({ title, values }: { title: string; values: unknown[] }) {
  return <div className="agent-chat-known-section">
    <h3>{title}</h3>
    {values.length > 0 ? <ul>{values.map((value, index) => <li key={index}>{renderMonoInline(readItemText(value))}</li>)}</ul> : <p>—</p>}
  </div>;
}

function renderStep(step: AgentTurn["steps"][number], translate: (key: string) => string): ReactNode {
  const tool = readString(step.data["tool"]);
  const phase = readString(step.data["phase"]);
  const detail = readString(step.data["summary"]) ?? readString(step.data["detail"]);
  const decision = readString(step.data["decision"]) ?? readString(step.data["action"]);
  const policy = readString(step.data["policyId"]) ?? readString(step.data["policy_id"]);
  if (step.name === "tool.call") return <><strong>{translate("agentStepToolCall")}</strong> <span className="mono">{tool ?? translate("agentUnknownTool")}</span></>;
  if (step.name === "tool.result") return <><strong>{translate("agentStepToolResult")}</strong> <span className="mono">{tool ?? translate("agentUnknownTool")}</span>{detail ? <p>{renderMonoInline(detail)}</p> : null}</>;
  if (step.name === "guardrail.decision") return <><strong>{translate("agentStepGuardrail")}</strong>{decision ? <span> · {renderMonoInline(decision)}</span> : null}{policy ? <span className="mono"> · {policy}</span> : null}{detail ? <p>{renderMonoInline(detail)}</p> : null}</>;
  if (step.name === "agent.step" && (phase === "handoff" || phase === "handoff_refused")) {
    const target = readString(step.data["to"]);
    return <><strong>{translate(phase === "handoff" ? "agentStepHandoff" : "agentStepHandoffRefused")}</strong>{target ? <span className="mono"> · {target}</span> : null}</>;
  }
  if (step.name === "agent.step" && phase === "trace_degraded") return <><strong>{translate("agentStepTraceNotice")}</strong>{detail ? <span> · {renderMonoInline(detail)}</span> : null}</>;
  if (step.name === "agent.step" && phase === "start") return <strong>{translate("agentStepPlan")}</strong>;
  if (step.name === "agent.step" && phase === "model") return <strong>{translate("agentStepModel")}</strong>;
  return <><strong>{step.name}</strong>{detail ? <span> · {renderMonoInline(detail)}</span> : null}</>;
}

function normalizeAnswer(data: Record<string, unknown>): AgentAnswer {
  const incomplete = readString(data["incomplete"]);
  return {
    answer: readString(data["answer"]) ?? "",
    citations: readArray(data["citations"]),
    retrievedCitations: readArray(data["retrieved_citations"]),
    known: readArray(data["known"]),
    unknown: readArray(data["unknown"]),
    assumptions: readArray(data["assumptions"]),
    confidence: readString(data["confidence"]) ?? "low",
    confidenceReason: readString(data["confidence_reason"]) ?? "",
    ...(incomplete ? { incomplete } : {}),
  };
}

function normalizeCitations(answer: AgentAnswer, turnId = "turn"): CitationView[] {
  return answer.citations.map((value, index) => {
    const record = isRecord(value) ? value : undefined;
    const id = typeof value === "string"
      ? value
      : readString(record?.["id"]) ?? readString(record?.["documentId"]) ?? readString(record?.["reference"]) ?? String(index + 1);
    const detail = answer.retrievedCitations.map((item) => isRecord(item) ? item : undefined)
      .find((item) => item && [item["id"], item["documentId"], item["citation"], item["reference"]].includes(id));
    const revision = readString(record?.["revision"]) ?? readString(detail?.["revision"]);
    const page = readString(record?.["page"]) ?? readString(detail?.["page"]);
    const clause = readString(record?.["clause"]) ?? readString(detail?.["clause"]);
    return {
      key: turnId + ":" + id + ":" + String(index),
      id,
      title: readString(record?.["title"]) ?? readString(record?.["name"]) ?? readString(detail?.["title"]) ?? id,
      ...(revision ? { revision } : {}),
      ...(page ? { page } : {}),
      ...(clause ? { clause } : {}),
    };
  });
}

function incompleteReason(reason: string | undefined, translate: (key: string) => string): string {
  const key = reason === "tool_calls" ? "agentIncompleteToolLimit"
    : reason === "wall_clock" ? "agentIncompleteTimeLimit"
      : reason === "token_budget" ? "agentIncompleteTokenLimit"
        : reason === "cancelled" ? "agentIncompleteCancelled" : "agentIncompleteNeedsReview";
  return translate(key);
}

function confidenceKey(confidence: string): "high" | "medium" | "low" {
  return confidence.toLowerCase() === "high" ? "high" : confidence.toLowerCase() === "medium" ? "medium" : "low";
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readItemText(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value)) return readString(value["text"]) ?? readString(value["detail"]) ?? readString(value["value"]) ?? "";
  return "";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function renderMonoInline(text: string): ReactNode {
  const tokenPattern = /([A-Z]{2,}(?:-[A-Z0-9]+)+|KP\s*[\d,.]+(?:[–-][\d,.]+)?|\b\d+(?:[.,]\d+)*\b)/g;
  const monoPattern = /^(?:[A-Z]{2,}(?:-[A-Z0-9]+)+|KP\s*[\d,.]+(?:[–-][\d,.]+)?|\d+(?:[.,]\d+)*)$/;
  return text.split(tokenPattern).map((part, index) => monoPattern.test(part) ? <span className="mono" key={index}>{part}</span> : part);
}
