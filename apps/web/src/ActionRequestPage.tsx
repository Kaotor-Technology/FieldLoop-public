import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ActionLevelBadge, Button, Skeleton } from "@fieldloop/ui";
import { ActionApprovalDialog } from "./ActionApprovalDialog";
import { actionRequestQueryKey, getActionRequest } from "./action-approval";
import { useCurrentSession } from "./SessionGate";

// The target of "Review and approve" on an Action Request card. After a forced re-login the BFF returns here with
// `?review=1`, which reopens the dialog, so the Approver never loses their place.
export function ActionRequestPage() {
  const { t } = useTranslation();
  const { actionRequestId } = useParams({ strict: false }) as { actionRequestId: string };
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const session = useCurrentSession();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(search["review"] === "1");
  const action = useQuery({ queryKey: actionRequestQueryKey(actionRequestId), queryFn: ({ signal }) => getActionRequest(actionRequestId, signal), retry: 1 });
  const record = action.data;
  const setReviewing = (next: boolean) => {
    setOpen(next);
    if (!next && search["review"] !== undefined) void navigate({ to: "/actions/$actionRequestId", params: { actionRequestId }, search: {}, replace: true });
  };

  return <main id="main-content" className="approval-page">
    <h1>{t("approvalPageTitle")}</h1>
    {action.isPending && <div role="status"><p>{t("approvalLoading")}</p><Skeleton variant="row" /></div>}
    {action.isError && <p className="approval-failure" role="alert">{t("approvalLoadFailed")}</p>}
    {record && session.data && <section className="approval-summary" aria-labelledby="approval-summary-heading">
      <h2 id="approval-summary-heading" className="approval-summary-id mono">{record.id}</h2>
      <p className="approval-meta">
        <ActionLevelBadge level={record.actionLevel} label={t("approvalActionLevel")} />
        {record.simulated && <span className="approval-simulation" lang="en">SIMULATION</span>}
        <span>{t("approvalStatus")}: {t(`approvalStatusValue.${record.status}`)}</span>
        <span>{t("approvalRequestedBy")} <span className="mono">{record.requestedBy}</span></span>
      </p>
      <ActionApprovalDialog action={record} user={session.data} open={open} onOpenChange={setReviewing}
        returnPath={`/actions/${record.id}?review=1`} onReload={() => { void action.refetch(); }}
        onDecided={(result) => { client.setQueryData(actionRequestQueryKey(record.id), result.actionRequest); }}
        trigger={<Button variant="primary">{t("approvalReview")}</Button>} />
    </section>}
  </main>;
}
