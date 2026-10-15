import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { approveDraft, DraftApiError, draftListQueryKey, draftQueryKey, getDraft, getDrafts, rejectDraft, type Draft, type DraftStatus } from "./drafts";
import { monoNumericText } from "./mono-numeric-text";
import { useCurrentSession } from "./SessionGate";

const TABS: DraftStatus[] = ["needs_approval", "approved", "rejected"];
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SOURCE_PATH_PATTERN = new RegExp(`^/api/v1/(?:bowties/${UUID_PATTERN}(?:/risk)?|action-requests/${UUID_PATTERN}|assets/[A-Za-z0-9][A-Za-z0-9._:-]{0,127})$`, "i");
const LINK_PATTERN = /\[([^\]]+)\]\(([^)\s]+)\)/g;

export function DraftReviewPage() {
  const { t, i18n } = useTranslation();
  const session = useCurrentSession();
  const search = useSearch({ from: "/drafts" });
  const navigate = useNavigate({ from: "/drafts" });
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<DraftStatus>("needs_approval");
  const [rejectReason, setRejectReason] = useState("");
  const [decisionResult, setDecisionResult] = useState<Draft | null>(null);
  const canRead = session.data?.roles.some((role) => role === "fieldloop.viewer" || role === "fieldloop.operator" || role === "fieldloop.manager") ?? false;
  const canDecide = session.data?.roles.some((role) => role === "fieldloop.operator" || role === "fieldloop.manager") ?? false;
  const draftsQuery = useQuery({
    queryKey: draftListQueryKey(status),
    queryFn: ({ signal }) => getDrafts(status, signal),
    enabled: canRead,
    retry: 1,
  });
  const items = draftsQuery.data ?? [];
  const routeDraftId = search.draftId;
  const needsDetail = Boolean(routeDraftId && !items.some((item) => item.id === routeDraftId));
  const selectedQuery = useQuery({
    queryKey: routeDraftId ? draftQueryKey(routeDraftId) : ["draft", "none"],
    queryFn: ({ signal }) => getDraft(routeDraftId ?? "", signal),
    enabled: canRead && needsDetail,
    retry: 1,
  });
  const selectedDraft = useMemo(() => {
    if (decisionResult && decisionResult.id === routeDraftId && decisionResult.status === status) return decisionResult;
    return items.find((item) => item.id === routeDraftId) ?? selectedQuery.data ?? items[0] ?? null;
  }, [decisionResult, items, routeDraftId, selectedQuery.data, status]);

  const finishDecision = async (draft: Draft) => {
    setDecisionResult(draft);
    setStatus(draft.status);
    setRejectReason("");
    await navigate({ search: { draftId: draft.id } });
    await Promise.all(TABS.map((tab) => queryClient.invalidateQueries({ queryKey: draftListQueryKey(tab) })));
    await queryClient.invalidateQueries({ queryKey: draftQueryKey(draft.id) });
  };
  const approve = useMutation({
    mutationFn: () => {
      if (!session.data || !selectedDraft) throw new Error("Draft is unavailable");
      return approveDraft(selectedDraft.id, session.data.csrfToken);
    },
    onSuccess: finishDecision,
  });
  const reject = useMutation({
    mutationFn: () => {
      if (!session.data || !selectedDraft) throw new Error("Draft is unavailable");
      return rejectDraft(selectedDraft.id, session.data.csrfToken, rejectReason);
    },
    onSuccess: finishDecision,
  });
  const decisionError = approve.error ?? reject.error;

  const selectStatus = (next: DraftStatus) => {
    setStatus(next);
    setDecisionResult(null);
    setRejectReason("");
    void navigate({ search: {} });
  };
  const selectDraft = (draftId: string) => {
    setDecisionResult(null);
    setRejectReason("");
    void navigate({ search: { draftId } });
  };

  if (session.data && !canRead) return <main id="main-content" className="draft-review-page" lang={i18n.resolvedLanguage ?? i18n.language}>
    <h1>{t("draftReview.title")}</h1>
    <p className="draft-review-error" role="alert">{t("draftReview.notAvailable")}</p>
  </main>;

  const selectedIsAuthor = selectedDraft ? isAuthor(selectedDraft, session.data?.sub) : false;
  const pending = approve.isPending || reject.isPending;
  const reauthRequired = decisionError instanceof DraftApiError && decisionError.code === "reauthentication_required";
  const selfApprovalRejected = decisionError instanceof DraftApiError && decisionError.code === "author_cannot_approve";
  const returnPath = `${location.pathname}${location.search}${location.hash}`;

  return <main id="main-content" className="draft-review-page" lang={i18n.resolvedLanguage ?? i18n.language} aria-busy={draftsQuery.isPending}>
    <header className="draft-review-heading">
      <div><p className="eyebrow">{t("draftReview.eyebrow")}</p><h1>{t("draftReview.title")}</h1></div>
      <p>{t("draftReview.description")}</p>
    </header>
    <div className="draft-review-tabs" role="tablist" aria-label={t("draftReview.statusTabs")}>
      {TABS.map((tab) => <button key={tab} type="button" role="tab" aria-selected={status === tab}
        onClick={() => selectStatus(tab)}>{t(`draftReview.status.${tab}`)}</button>)}
    </div>
    {draftsQuery.isError && <p className="draft-review-error" role="alert">{t("draftReview.loadError")}</p>}
    {selectedQuery.isError && <p className="draft-review-error" role="alert">{t("draftReview.detailError")}</p>}
    <div className="draft-review-layout">
      <nav className="draft-review-list" aria-label={t("draftReview.listLabel")}>
        {draftsQuery.isPending && <p role="status">{t("draftReview.loading")}</p>}
        {!draftsQuery.isPending && !draftsQuery.isError && items.length === 0 && <p className="draft-review-empty">{t("draftReview.empty")}</p>}
        {items.map((draft) => <button type="button" key={draft.id} className="draft-review-list-item"
          aria-current={selectedDraft?.id === draft.id ? "true" : undefined} onClick={() => selectDraft(draft.id)}>
          <span className="draft-review-list-title">{t("draftReview.managementSummary")}</span>
          <span className="draft-review-list-meta mono">{monoNumericText(formatDay(draft.createdAt))}</span>
          {draft.simulated && <span className="audit-simulation" lang="en">SIMULATION</span>}
        </button>)}
      </nav>
      {selectedDraft ? <article className="draft-review-detail" aria-labelledby="draft-review-detail-heading">
        <div className="draft-review-detail-heading">
          <div><p className="eyebrow">{t("draftReview.managementSummary")}</p><h2 id="draft-review-detail-heading">{t(`draftReview.status.${selectedDraft.status}`)}</h2></div>
          {selectedDraft.simulated && <span className="audit-simulation" lang="en">SIMULATION</span>}
        </div>
        <p className="draft-review-created">{t("draftReview.created", { date: formatDay(selectedDraft.createdAt) })}</p>
        <dl className="draft-review-metadata">
          <div><dt>{t("classification")}</dt><dd className="mono">{selectedDraft.classification}</dd></div>
          {selectedDraft.confidence !== null && <div><dt>{t("draftReview.confidence")}</dt><dd className="mono">{formatPercent(selectedDraft.confidence, i18n.language)}</dd></div>}
        </dl>
        <section className="draft-review-content" aria-label={t("draftReview.contentLabel")}>
          {renderDraftContent(selectedDraft.content)}
        </section>
        {selectedDraft.citations.length > 0 && <section className="draft-review-citations" aria-labelledby="draft-review-citations-heading">
          <h3 id="draft-review-citations-heading">{t("draftReview.sources")}</h3>
          <ul>{selectedDraft.citations.map((citation) => <li key={citation}>
            {isSafeSourcePath(citation)
              ? <a href={citation} target="_blank" rel="noreferrer" aria-label={t("draftReview.openSource", { source: citation })}>{monoNumericText(citation)}</a>
              : <span className="mono">{monoNumericText(citation)}</span>}
          </li>)}</ul>
        </section>}
        {selectedDraft.approvalStamp && <p className="draft-review-approval-stamp" lang="en">{monoNumericText(selectedDraft.approvalStamp)}</p>}
        {selectedDraft.status === "rejected" && selectedDraft.decisionReason && <p className="draft-review-reason">{t("draftReview.rejectionReason", { reason: selectedDraft.decisionReason })}</p>}
        {selectedDraft.status === "needs_approval" && canDecide && <section className="draft-review-decision" aria-label={t("draftReview.decisionControls")}>
          {selectedIsAuthor && <p className="draft-review-error" role="status">{t("draftReview.authorCannotApprove")}</p>}
          {selectedDraft.createdBy.startsWith("agent:") && !selectedDraft.createdBy.includes("on_behalf_of:") && <p className="draft-review-error" role="status">{t("draftReview.authorUnknown")}</p>}
          {decisionError && <p className="draft-review-error" role="alert">{selfApprovalRejected ? t("draftReview.authorCannotApprove") : t("draftReview.decisionError")}</p>}
          {reauthRequired && <a className="draft-review-reauth" href={`/api/auth/reauth?${new URLSearchParams({ return: returnPath })}`}>{t("draftReview.reauthenticate")}</a>}
          <label className="draft-review-reason-label" htmlFor="draft-review-rejection-reason">{t("draftReview.reasonLabel")}
            <textarea id="draft-review-rejection-reason" value={rejectReason} maxLength={2000} onChange={(event) => setRejectReason(event.target.value)} disabled={pending} />
          </label>
          <div className="draft-review-actions">
            <button type="button" className="draft-review-approve" onClick={() => approve.mutate()} disabled={pending || selectedIsAuthor || (selectedDraft.createdBy.startsWith("agent:") && !selectedDraft.createdBy.includes("on_behalf_of:"))}>
              {t(pending ? "draftReview.saving" : "draftReview.approve")}
            </button>
            <button type="button" onClick={() => reject.mutate()} disabled={pending || !rejectReason.trim()}>
              {t("draftReview.reject")}
            </button>
          </div>
        </section>}
        {selectedDraft.status === "needs_approval" && !canDecide && <p className="draft-review-read-only">{t("draftReview.readOnly")}</p>}
      </article> : (!draftsQuery.isPending && !draftsQuery.isError && !selectedQuery.isPending && <p className="draft-review-empty">{t("draftReview.selectPrompt")}</p>)}
    </div>
  </main>;
}

function isAuthor(draft: Draft, userSub: string | undefined): boolean {
  if (!userSub) return false;
  const delegated = /(?:^|\s)on_behalf_of:([^\s]+)/.exec(draft.createdBy)?.[1];
  return delegated === userSub || (!draft.createdBy.startsWith("agent:") && draft.createdBy === userSub);
}

function isSafeSourcePath(path: string): boolean {
  return SOURCE_PATH_PATTERN.test(path);
}

function renderDraftContent(content: string) {
  return content.split("\n").map((line, lineIndex) => {
    const pieces: React.ReactNode[] = [];
    let cursor = 0;
    for (const match of line.matchAll(LINK_PATTERN)) {
      const start = match.index ?? 0;
      const raw = match[0];
      const label = match[1] ?? "";
      const path = match[2] ?? "";
      if (start > cursor) pieces.push(monoNumericText(line.slice(cursor, start)));
      if (isSafeSourcePath(path)) pieces.push(<a key={`${lineIndex}:${start}`} href={path} target="_blank" rel="noreferrer">{monoNumericText(label)}</a>);
      else pieces.push(monoNumericText(raw));
      cursor = start + raw.length;
    }
    if (cursor < line.length) pieces.push(monoNumericText(line.slice(cursor)));
    return <p key={lineIndex}>{pieces.length ? pieces : " "}</p>;
  });
}

function formatDay(value: string): string {
  return value.slice(0, 10);
}

function formatPercent(value: number, language: string): string {
  return new Intl.NumberFormat(language === "th" ? "th-TH" : "en-GB", {
    style: "percent", maximumFractionDigits: 0,
  }).format(value);
}
