import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ActionLevelBadge, Button, Modal, Textarea } from "@fieldloop/ui";
import "./approval-dialog.css";
import type { CurrentUser } from "./api-client";
import {
  createIdempotencyKeys, decideActionRequest, decisionBlock, failureKind, formatCountdown, isLoginFresh, needsSecondApproval,
  reauthDestination, type ActionDecision, type ActionDecisionResult, type ActionRequest, type DecisionBlock, type FailureKind,
} from "./action-approval";

type Approver = Pick<CurrentUser, "sub" | "authTime" | "csrfToken"> & { roles: readonly string[] };

interface BodyProps {
  action: ActionRequest;
  block: DecisionBlock;
  now: number;
  reason: string;
  onReason: (value: string) => void;
  failure: FailureKind | null;
  decided: ActionDecisionResult | null;
  submitting: boolean;
  needsLogin: boolean;
  onReload?: (() => void) | undefined;
}

// What the dialog shows: the exact payload and hash, a candid does / does-not pair, the reason field and the notices.
export function ActionApprovalBody({ action, block, now, reason, onReason, failure, decided, submitting, needsLogin, onReload }: BodyProps) {
  const { t } = useTranslation();
  const known = ["internal_record", "system_of_record", "field_command", "emergency_communication", "external_submission", "engineering_approval"].includes(action.actionType);
  const kind = known ? action.actionType : "generic";
  const target = action.target;
  return <div className="approval-body">
    <div className="approval-meta">
      <ActionLevelBadge level={action.actionLevel} label={t("approvalActionLevel")} />
      {action.simulated && <span className="approval-simulation" lang="en">SIMULATION</span>}
      <span>{t("approvalTimeLeft")} <time className="mono" dateTime={action.expiresAt}>{formatCountdown(action.expiresAt, now)}</time></span>
      <span>{t("approvalRequestedBy")} <span className="mono">{action.requestedBy}</span>{action.requester.kind === "assistant" && <> · {t("approvalRaisedByAssistant")}</>}</span>
    </div>
    <div className="approval-pair">
      <section aria-labelledby={`${action.id}-does`}>
        <h3 id={`${action.id}-does`}>{t("approvalDoesHeading")}</h3>
        <p>{t(`approvalDoes.${kind}`, { target })}</p>
      </section>
      <section aria-labelledby={`${action.id}-does-not`}>
        <h3 id={`${action.id}-does-not`}>{t("approvalDoesNotHeading")}</h3>
        <p>{t(`approvalDoesNot.${kind}`, { target })}{action.simulated && <> {t("approvalDoesNotSimulated")}</>}</p>
      </section>
    </div>
    <section aria-labelledby={`${action.id}-payload`}>
      <h3 id={`${action.id}-payload`}>{t("approvalPayload")}</h3>
      <pre className="approval-payload mono" tabIndex={0} aria-labelledby={`${action.id}-payload`}>{JSON.stringify(action.payload, null, 2)}</pre>
      <p className="approval-hash"><span>{t("approvalPayloadHash")}</span> <code className="mono">{action.payloadHash}</code></p>
    </section>
    <section aria-labelledby={`${action.id}-why`}>
      <h3 id={`${action.id}-why`}>{t("approvalRationale")}</h3>
      <p>{action.rationale}</p>
      <ul className="approval-citations">{action.citations.map((citation) => <li key={citation} className="mono">{citation}</li>)}</ul>
    </section>
    {needsSecondApproval(action.actionType) && <SecondApproverMock />}
    {block && !decided && <p className="approval-notice" role="status">{t(`approvalBlock.${block}`)}</p>}
    {!block && !decided && <>
      <Textarea label={t("approvalReason")} helper={t("approvalReasonHelper")} value={reason} required disabled={submitting}
        onChange={(event) => onReason(event.currentTarget.value)} />
      {needsLogin && <p className="approval-notice" role="status">{t("approvalLoginRequired")}</p>}
    </>}
    {failure && <p className="approval-failure" role="alert">{t(`approvalFailure.${failure}`)}{failure === "payload_changed" && onReload && <> <Button type="button" variant="secondary" size="sm" onClick={onReload}>{t("approvalReload")}</Button></>}</p>}
    {decided && <p className="approval-notice" role="status">{t(decided.approval.decision === "approved" ? "approvalRecorded" : "approvalRejectedRecorded")}</p>}
  </div>;
}

// FL-208: a labelled mock. The two-person rule is Phase 1; the demo records exactly one real Approval (PRD Q61).
function SecondApproverMock() {
  const { t } = useTranslation();
  return <section className="approval-mock" aria-labelledby="approval-mock-heading">
    <h3 id="approval-mock-heading">{t("approvalSecondTitle")} <span className="approval-mock-tag" lang="en">MOCK</span></h3>
    <p>{t("approvalSecondBody")}</p>
    <ol className="approval-steps">
      <li>{t("approvalStepFirst")}</li>
      <li>{t("approvalStepSecond")}</li>
    </ol>
  </section>;
}

interface DialogProps {
  action: ActionRequest;
  user: Approver;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDecided: (result: ActionDecisionResult) => void;
  returnPath: string;
  trigger: ReactNode;
  onReload?: () => void;
}

export function ActionApprovalDialog({ action, user, open, onOpenChange, onDecided, returnPath, trigger, onReload }: DialogProps) {
  const { t, i18n } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<FailureKind | null>(null);
  const [decided, setDecided] = useState<ActionDecisionResult | null>(null);
  const keys = useRef(createIdempotencyKeys());
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [open]);

  const block = decisionBlock(action, user, now);
  const needsLogin = !isLoginFresh(user.authTime, now) || failure === "reauthentication_required";
  const trimmed = reason.trim();
  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) { setReason(""); setFailure(null); setDecided(null); }
  };
  const decide = async (decision: ActionDecision) => {
    if (!trimmed || submitting) return;
    setSubmitting(true); setFailure(null);
    try {
      // No optimistic update: the dialog shows only what the server returned (docs/architecture.md §3).
      const result = await decideActionRequest({ actionRequestId: action.id, decision, payloadHash: action.payloadHash, reason: trimmed,
        idempotencyKey: keys.current({ actionRequestId: action.id, decision, payloadHash: action.payloadHash, reason: trimmed }), csrfToken: user.csrfToken });
      setDecided(result); onDecided(result);
    } catch (error) {
      setFailure(failureKind(error));
    } finally {
      setSubmitting(false);
    }
  };
  const canDecide = block === null && !decided;
  const footer = canDecide && (needsLogin
    ? <Button variant="primary" onClick={() => window.location.assign(reauthDestination(returnPath))}>{t("approvalSignInAgain")}</Button>
    : <>
      <Button variant="secondary" disabled={!trimmed} loading={submitting} onClick={() => { void decide("reject"); }}>{t("approvalReject")}</Button>
      <Button variant="primary" disabled={!trimmed} loading={submitting} onClick={() => { void decide("approve"); }}>{t("approvalApprove")}</Button>
    </>);

  return <Modal approval open={open} onOpenChange={close} trigger={trigger} lang={i18n.resolvedLanguage ?? i18n.language}
    title={t(`approvalTitle.${titleKey(action)}`, { target: action.target })} description={t("approvalDescription")}
    closeLabel={decided ? t("close") : t("cancel")} footer={footer || undefined}>
    <ActionApprovalBody action={action} block={block} now={now} reason={reason} onReason={setReason} failure={failure} decided={decided}
      submitting={submitting} needsLogin={needsLogin} onReload={onReload} />
  </Modal>;
}

function titleKey(action: ActionRequest): string {
  if (action.actionType === "emergency_communication" || action.actionType === "external_submission") {
    return `${action.actionType}${action.simulated ? "_simulated" : ""}`;
  }
  return ["internal_record", "system_of_record", "field_command"].includes(action.actionType) ? action.actionType : "generic";
}
