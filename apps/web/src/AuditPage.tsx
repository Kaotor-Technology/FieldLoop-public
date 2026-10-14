import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { AuditLog } from "./AuditLog";
import { auditQueryKey, canReadAudit, getAuditPage, type AuditFilter } from "./audit-events";
import { useCurrentSession } from "./SessionGate";

export function auditSearch(search: Record<string, unknown>): AuditFilter {
  return {
    ...(typeof search["entityType"] === "string" && search["entityType"] ? { entityType: search["entityType"] } : {}),
    ...(typeof search["entityId"] === "string" && search["entityId"] ? { entityId: search["entityId"] } : {}),
  };
}

export function AuditPage() {
  const { t } = useTranslation();
  const session = useCurrentSession();
  const navigate = useNavigate();
  const filter = auditSearch(useSearch({ strict: false }) as Record<string, unknown>);
  const allowed = session.data ? canReadAudit(session.data.roles) : false;
  const pages = useInfiniteQuery({
    queryKey: auditQueryKey(filter),
    queryFn: ({ signal, pageParam }) => getAuditPage(signal, filter, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: allowed,
    retry: 1,
  });
  if (session.data && !allowed) return <main id="main-content" className="audit-page">
    <h1>{t("auditLog")}</h1>
    <p className="audit-error" role="alert">{t("auditNotAvailable")}</p>
  </main>;
  return <AuditLog
    events={pages.data?.pages.flatMap((page) => page.items) ?? []}
    filter={filter}
    isLoading={pages.isPending}
    hasError={pages.isError}
    hasMore={pages.hasNextPage}
    isLoadingMore={pages.isFetchingNextPage}
    onLoadMore={() => { void pages.fetchNextPage(); }}
    onFilter={(next) => { void navigate({ to: "/audit", search: { ...next } }); }}
  />;
}
