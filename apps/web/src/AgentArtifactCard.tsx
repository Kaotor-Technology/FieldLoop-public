import { useQuery } from "@tanstack/react-query";
import type { components } from "@fieldloop/contracts";
import { useTranslation } from "react-i18next";
import { actionRequestQueryKey } from "./action-request-events";
import { api } from "./api-client";

type ActionRequest = components["schemas"]["ActionRequest"];

export function AgentArtifactCard({ actionRequestId }: { actionRequestId: string }) {
  const { t, i18n } = useTranslation();
  const actionRequest = useQuery({
    queryKey: actionRequestQueryKey(actionRequestId),
    queryFn: async ({ signal }): Promise<ActionRequest> => {
      const result = await api.GET("/v1/action-requests/{actionRequestId}", {
        params: { path: { actionRequestId } }, signal,
      });
      if (!result.response.ok || !result.data) throw new Error("Action Request could not be loaded");
      return result.data;
    },
    retry: false,
  });

  return <section className="agent-chat-artifact-card" aria-label={t("agentActionRequestCard")}>
    <header className="agent-chat-artifact-heading">
      <h3>{t("agentActionRequest")}</h3>
      {actionRequest.data ? <span className="agent-chat-artifact-status">{t(`actionRequestStatus.${actionRequest.data.status}`)}</span> : null}
    </header>
    {actionRequest.isPending ? <p className="agent-chat-artifact-loading" role="status">{t("agentActionRequestLoading")}</p> : null}
    {actionRequest.isError ? <div className="agent-chat-artifact-error" role="alert">
      <p>{t("agentActionRequestUnavailable")}</p>
      <button type="button" onClick={() => void actionRequest.refetch()}>{t("retry")}</button>
    </div> : null}
    {actionRequest.data ? <>
      <dl className="agent-chat-artifact-details">
        <dt>{t("agentActionLevel")}</dt><dd><span className="agent-chat-action-level mono">{actionRequest.data.actionLevel.toUpperCase()}</span></dd>
        <dt>{t("agentActionTarget")}</dt><dd>{actionRequest.data.target}</dd>
        <dt>{t("agentActionSla")}</dt><dd className="mono"><time dateTime={actionRequest.data.expiresAt}>{formatSla(actionRequest.data.expiresAt, i18n.resolvedLanguage ?? "en")}</time></dd>
        <dt>{t("agentActionRequestId")}</dt><dd className="mono">{actionRequest.data.id}</dd>
      </dl>
      <a className="agent-chat-review-link" href={`/action-requests/${encodeURIComponent(actionRequest.data.id)}`}>{t("agentReviewAndApprove")}</a>
    </> : null}
  </section>;
}

function formatSla(value: string, language: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
