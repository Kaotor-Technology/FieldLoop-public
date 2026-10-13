import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button, HealthBadge, Skeleton, Textarea } from "@fieldloop/ui";
import type { BarrierHealth } from "@fieldloop/ui";

export interface HealthProposalReviewRecord {
  id: string;
  barrierId: string;
  barrierName?: string;
  currentHealth?: BarrierHealth;
  proposedHealth: BarrierHealth;
  sourceReason?: string;
  simulated: boolean;
}

export type HealthProposalDecision = "accept" | "reject";

interface HealthProposalReviewProps {
  proposals: readonly HealthProposalReviewRecord[];
  isLoading?: boolean;
  hasError?: boolean;
  onDecision: (input: { proposalId: string; decision: HealthProposalDecision; reason: string }) => Promise<void>;
}

interface SelectedDecision {
  proposalId: string;
  decision: HealthProposalDecision;
}

export function HealthProposalReview({ proposals, isLoading = false, hasError = false, onDecision }: HealthProposalReviewProps) {
  const { t, i18n } = useTranslation();
  const [selectedDecision, setSelectedDecision] = useState<SelectedDecision | null>(null);
  const [reason, setReason] = useState("");
  const [reasonInvalid, setReasonInvalid] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [decisionFailed, setDecisionFailed] = useState(false);
  const [savedProposalId, setSavedProposalId] = useState<string | null>(null);

  const openDecision = (proposalId: string, decision: HealthProposalDecision) => {
    setSelectedDecision({ proposalId, decision });
    setReason("");
    setReasonInvalid(false);
    setDecisionFailed(false);
    setSavedProposalId(null);
  };

  const cancelDecision = () => {
    setSelectedDecision(null);
    setReason("");
    setReasonInvalid(false);
    setDecisionFailed(false);
  };

  const submitDecision = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedDecision) return;
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      setReasonInvalid(true);
      return;
    }

    setSubmitting(true);
    setDecisionFailed(false);
    try {
      await onDecision({ ...selectedDecision, reason: trimmedReason });
      setSavedProposalId(selectedDecision.proposalId);
      setSelectedDecision(null);
      setReason("");
      setReasonInvalid(false);
    } catch {
      setDecisionFailed(true);
    } finally {
      setSubmitting(false);
    }
  };

  const language = i18n.resolvedLanguage ?? i18n.language;
  const healthLabel = (health: BarrierHealth) => t(health, { defaultValue: t(`healthProposalHealth.${health}`) });

  return <section className="health-proposal-section" aria-labelledby="health-proposal-heading" lang={language} aria-busy={isLoading || submitting}>
    <div className="health-proposal-heading">
      <h3 id="health-proposal-heading">{t("healthProposals")}</h3>
      <strong className="mono" aria-label={t("healthProposalCount", { count: proposals.length })}>{proposals.length}</strong>
    </div>

    {isLoading && <div className="health-proposal-loading" role="status">
      <span>{t("healthProposalsLoading")}</span>
      <Skeleton variant="row" />
      <Skeleton variant="row" />
    </div>}
    {hasError && <p className="health-proposal-error" role="alert">{t("healthProposalsLoadFailed")}</p>}
    {!isLoading && proposals.length === 0 && !hasError && <p className="health-proposal-empty" role="status">{t("healthProposalsEmpty")}</p>}

    {proposals.length > 0 && <ul className="health-proposal-list">
      {proposals.map((proposal) => {
        const isSelected = selectedDecision?.proposalId === proposal.id;
        const saved = savedProposalId === proposal.id;
        const targetName = proposal.barrierName ?? proposal.barrierId;
        const formId = `health-proposal-reason-${proposal.id}`;
        return <li key={proposal.id} className="health-proposal-row">
          <div className="health-proposal-target">
            {proposal.barrierName && <strong>{proposal.barrierName}</strong>}
            <code className="mono">{proposal.barrierId}</code>
          </div>
          <div className="health-proposal-transition" role="group" aria-label={t("healthProposalChange")}>
            {proposal.currentHealth && <HealthBadge health={proposal.currentHealth} label={healthLabel(proposal.currentHealth)} />}
            {proposal.currentHealth && <span aria-hidden="true">→</span>}
            <HealthBadge health={proposal.proposedHealth} label={healthLabel(proposal.proposedHealth)} />
          </div>
          {proposal.sourceReason && <p className="health-proposal-source-reason">{proposal.sourceReason}</p>}
          {proposal.simulated && <span className="health-proposal-simulation">{t("healthProposalSimulationLabel")}</span>}

          {saved && <p className="health-proposal-saved" role="status">{t("healthProposalDecisionSaved")}</p>}
          {!saved && !isSelected && <div className="health-proposal-actions">
            <Button type="button" variant="primary" disabled={submitting} aria-label={t("healthProposalAcceptFor", { barrier: targetName })} onClick={() => openDecision(proposal.id, "accept")}>
              {t("healthProposalAccept")}
            </Button>
            <Button type="button" variant="secondary" disabled={submitting} aria-label={t("healthProposalRejectFor", { barrier: targetName })} onClick={() => openDecision(proposal.id, "reject")}>
              {t("healthProposalReject")}
            </Button>
          </div>}

          {isSelected && <form className="health-proposal-decision-form" aria-labelledby={`${formId}-heading`} onSubmit={(event) => { void submitDecision(event); }}>
            <h4 id={`${formId}-heading`}>{selectedDecision.decision === "accept" ? t("healthProposalAcceptTitle") : t("healthProposalRejectTitle")}</h4>
            <Textarea
              id={formId}
              autoFocus
              label={t("healthProposalDecisionReason")}
              helper={t("healthProposalReasonHelper")}
              {...(reasonInvalid ? { error: t("healthProposalReasonRequired") } : {})}
              value={reason}
              required
              onChange={(event) => { setReason(event.currentTarget.value); if (reasonInvalid) setReasonInvalid(false); }}
            />
            {decisionFailed && <p className="health-proposal-error" role="alert">{t("healthProposalDecisionFailed")}</p>}
            <div className="health-proposal-actions">
              <Button type="submit" variant={selectedDecision.decision === "accept" ? "primary" : "secondary"} loading={submitting} disabled={!reason.trim()}>
                {submitting ? t("healthProposalSubmitting") : selectedDecision.decision === "accept" ? t("healthProposalAccept") : t("healthProposalReject")}
              </Button>
              <Button type="button" variant="secondary" disabled={submitting} onClick={cancelDecision}>{t("cancel")}</Button>
            </div>
          </form>}
        </li>;
      })}
    </ul>}
    {decisionFailed && !selectedDecision && <p className="health-proposal-error" role="alert">{t("healthProposalDecisionFailed")}</p>}
  </section>;
}
