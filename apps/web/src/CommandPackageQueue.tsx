import { useState, type FormEvent } from "react";
import type { TFunction } from "i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useCurrentSession } from "./SessionGate";
import { commandPackageQueryKey, getCommandPackages, recordCommandPackageOutcome, type CommandPackage, type CommandPackageOutcome, type CommandPackageStatus } from "./command-packages";

const statuses: CommandPackageStatus[] = ["queued", "executed", "not_executed"];
const requiredApprovalCount = 2;

export function CommandPackageQueue() {
  const { t, i18n } = useTranslation();
  const session = useCurrentSession();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<CommandPackageStatus>("queued");
  const user = session.data;
  const operator = Boolean(user && !user.sub.startsWith("agent:") && user.roles.includes("fieldloop.operator"));
  const page = useQuery({
    queryKey: commandPackageQueryKey(status),
    queryFn: ({ signal }) => getCommandPackages(signal, status),
    enabled: operator,
    retry: 1,
  });
  const outcome = useMutation({
    mutationFn: ({ id, body }: { id: string; body: CommandPackageOutcome }) => {
      if (!user) throw new Error("Session is unavailable");
      return recordCommandPackageOutcome(id, body, user.csrfToken);
    },
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["command-packages"] }); },
  });
  const language = i18n.language.startsWith("th") ? "th" : "en";

  if (user && !operator) return <main id="main-content" className="command-package-page" lang={language}>
    <h1>{t("commandPackagesTitle")}</h1>
    <p className="command-package-alert" role="alert">{t("commandPackagesNotAvailable")}</p>
  </main>;

  return <main id="main-content" className="command-package-page" lang={language}>
    <header className="command-package-header">
      <div>
        <p className="command-package-eyebrow">{t("commandPackagesEyebrow")}</p>
        <h1>{t("commandPackagesTitle")}</h1>
        <p className="command-package-intro">{t("commandPackagesIntro")}</p>
      </div>
      <p className="command-package-safety-note">{t("commandPackagesHumanNote")}</p>
    </header>

    <nav className="command-package-tabs" aria-label={t("commandPackagesFilters")}>
      {statuses.map((item) => <button key={item} type="button" aria-pressed={status === item} onClick={() => { setStatus(item); outcome.reset(); }}>
        {t(`commandPackageFilter.${item}`)}
      </button>)}
    </nav>

    {page.isPending && <p className="command-package-status" role="status">{t("commandPackagesLoading")}</p>}
    {page.isError && <div className="command-package-alert" role="alert">
      <p>{t("commandPackagesLoadFailed")}</p>
      <button type="button" onClick={() => { void page.refetch(); }}>{t("retry")}</button>
    </div>}
    {page.data?.items.length === 0 && <p className="command-package-empty" role="status">{t(`commandPackageEmpty.${status}`)}</p>}
    <div className="command-package-list" aria-busy={page.isFetching}>
      {page.data?.items.map((item) => <CommandPackageCard key={item.id} item={item} t={t} onSubmit={(body) => outcome.mutate({ id: item.id, body })}
        isSubmitting={outcome.isPending && outcome.variables?.id === item.id}
        {...(outcome.isError && outcome.variables?.id === item.id ? { error: t("commandPackageOutcomeFailed") } : {})}
        {...(outcome.isSuccess && outcome.variables?.id === item.id ? { success: t("commandPackageOutcomeSaved") } : {})}
      />)}
    </div>
  </main>;
}

function CommandPackageCard({ item, t, onSubmit, isSubmitting, error, success }: {
  item: CommandPackage;
  t: TFunction;
  onSubmit: (body: CommandPackageOutcome) => void;
  isSubmitting: boolean;
  error?: string;
  success?: string;
}) {
  const [executionStatus, setExecutionStatus] = useState<"executed" | "not_executed">("executed");
  const [outcome, setOutcome] = useState("");
  const approved = item.actionStatus === "approved" && item.approvalCount >= requiredApprovalCount && item.executionStatus === "queued";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!approved || !outcome.trim()) return;
    onSubmit({ executionStatus, outcome: outcome.trim() });
  }

  return <article className="command-package-card" aria-labelledby={`command-package-${item.id}`}>
    <header className="command-package-card-header">
      <div>
        <p className="command-package-target mono" lang="en">{item.target}</p>
        <h2 id={`command-package-${item.id}`}>{item.action}</h2>
      </div>
      {item.simulated && <span className="command-package-simulation" lang="en">SIMULATION</span>}
    </header>
    <dl className="command-package-details">
      <div><dt>{t("commandPackageRationale")}</dt><dd>{item.rationale}</dd></div>
      <div><dt>{t("commandPackageProcedure")}</dt><dd className="mono" lang="en">{item.procedure}</dd></div>
      <div><dt>{t("commandPackagePreconditions")}</dt><dd><ul>{item.preconditions.map((condition) => <li key={condition}>{condition}</li>)}</ul></dd></div>
      <div><dt>{t("commandPackageExpectedEffect")}</dt><dd>{item.expectedEffect}</dd></div>
      <div><dt>{t("commandPackageCitations")}</dt><dd><ul>{item.citations.map((citation) => <li className="mono" key={citation}>{citation}</li>)}</ul></dd></div>
      <div><dt>{t("commandPackageApproval")}</dt><dd>
        <span className="command-package-state">{t(`commandPackageActionStatus.${item.actionStatus}`)}</span>
        <span className="command-package-approval-count mono" aria-label={t("commandPackageApprovalCount", { count: item.approvalCount })}>{item.approvalCount}/{requiredApprovalCount}</span>
      </dd></div>
      <div><dt>{t("commandPackageRequestId")}</dt><dd className="mono">{item.actionRequestId}</dd></div>
    </dl>

    {item.executionStatus !== "queued" ? <section className="command-package-recorded" aria-label={t("commandPackageRecordedOutcome")}>
      <h3>{t("commandPackageRecordedOutcome")}</h3>
      <p><strong>{t(`commandPackageFilter.${item.executionStatus}`)}</strong> · {item.outcome}</p>
      {item.evidenceId && <p>{t("commandPackageEvidenceId")}: <span className="mono">{item.evidenceId}</span></p>}
      {item.recordedAt && <p className="mono">{item.recordedAt}</p>}
    </section> : <form className="command-package-outcome" onSubmit={submit}>
      <fieldset disabled={!approved || isSubmitting}>
        <legend>{t("commandPackageOutcomeLegend")}</legend>
        <div className="command-package-radio-group">
          <label><input type="radio" name={`execution-${item.id}`} value="executed" checked={executionStatus === "executed"} onChange={() => setExecutionStatus("executed")} />{t("commandPackageExecuted")}</label>
          <label><input type="radio" name={`execution-${item.id}`} value="not_executed" checked={executionStatus === "not_executed"} onChange={() => setExecutionStatus("not_executed")} />{t("commandPackageNotExecuted")}</label>
        </div>
        <label className="command-package-outcome-label" htmlFor={`outcome-${item.id}`}>{t("commandPackageOutcomeLabel")}</label>
        <textarea id={`outcome-${item.id}`} rows={3} maxLength={2000} required value={outcome} onChange={(event) => setOutcome(event.target.value)} aria-describedby={`outcome-help-${item.id}`} />
        <span className="command-package-help" id={`outcome-help-${item.id}`}>{t("commandPackageOutcomeHelp")}</span>
        <button className="command-package-submit" type="submit" disabled={!approved || isSubmitting || !outcome.trim()}>{isSubmitting ? t("commandPackageSaving") : t("commandPackageSubmit")}</button>
      </fieldset>
      {!approved && <p className="command-package-pending" role="status">{t("commandPackageApprovalPending", { count: item.approvalCount })}</p>}
      {error && <p className="command-package-alert" role="alert">{error}</p>}
      {success && <p className="command-package-success" role="status">{success}</p>}
    </form>}
  </article>;
}
