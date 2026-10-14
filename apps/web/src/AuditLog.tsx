import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Skeleton } from "@fieldloop/ui";
import { entityTypePattern, formatAuditTime, type AuditEvent, type AuditFilter } from "./audit-events";

interface AuditLogProps {
  events: readonly AuditEvent[];
  filter: AuditFilter;
  isLoading?: boolean;
  hasError?: boolean;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  onFilter: (filter: AuditFilter) => void;
}

export function AuditLog({ events, filter, isLoading = false, hasError = false, hasMore = false, isLoadingMore = false, onLoadMore, onFilter }: AuditLogProps) {
  const { t, i18n } = useTranslation();
  const [entityType, setEntityType] = useState(filter.entityType ?? "");
  const [entityId, setEntityId] = useState(filter.entityId ?? "");
  const [typeInvalid, setTypeInvalid] = useState(false);
  const language = i18n.resolvedLanguage ?? i18n.language;
  const filtered = Boolean(filter.entityType || filter.entityId);

  const apply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const type = entityType.trim();
    const id = entityId.trim();
    if (type && !entityTypePattern.test(type)) { setTypeInvalid(true); return; }
    setTypeInvalid(false);
    onFilter({ ...(type ? { entityType: type } : {}), ...(id ? { entityId: id } : {}) });
  };
  const clear = () => {
    setEntityType("");
    setEntityId("");
    setTypeInvalid(false);
    onFilter({});
  };

  return <main id="main-content" className="audit-page" lang={language} aria-labelledby="audit-heading" aria-busy={isLoading}>
    <div className="audit-heading">
      <h1 id="audit-heading">{t("auditLog")}</h1>
      <strong className="mono" aria-label={t("auditCount", { count: events.length })}>{events.length}</strong>
    </div>
    <p className="audit-note">{t("auditReadOnlyNote")}</p>

    <form className="audit-filter" onSubmit={apply} aria-label={t("auditFilterLabel")}>
      <Input label={t("auditEntityType")} helper={t("auditEntityTypeHelper")} value={entityType} maxLength={64}
        autoComplete="off" spellCheck={false} numeric {...(typeInvalid ? { error: t("auditEntityTypeInvalid") } : {})}
        onChange={(event) => { setEntityType(event.currentTarget.value); if (typeInvalid) setTypeInvalid(false); }} />
      <Input label={t("auditEntityId")} value={entityId} maxLength={256} autoComplete="off" spellCheck={false} numeric
        onChange={(event) => setEntityId(event.currentTarget.value)} />
      <div className="audit-filter-actions">
        <Button type="submit" variant="primary">{t("auditFilterApply")}</Button>
        <Button type="button" variant="secondary" disabled={!filtered && !entityType && !entityId} onClick={clear}>{t("auditFilterClear")}</Button>
      </div>
    </form>

    {isLoading && <div className="audit-status" role="status">
      <span>{t("auditLoading")}</span>
      <Skeleton variant="row" />
      <Skeleton variant="row" />
    </div>}
    {hasError && <p className="audit-error" role="alert">{t("auditLoadFailed")}</p>}
    {!isLoading && !hasError && events.length === 0 && <p className="audit-status" role="status">{filtered ? t("auditEmptyFiltered") : t("auditEmpty")}</p>}

    {events.length > 0 && <div className="audit-table-wrap">
      <table className="audit-table">
        <caption className="audit-caption">{t("auditTableCaption")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("auditColumnTime")}</th>
            <th scope="col">{t("auditColumnAction")}</th>
            <th scope="col">{t("auditColumnEntity")}</th>
            <th scope="col">{t("auditColumnActor")}</th>
            <th scope="col">{t("auditColumnClassification")}</th>
            <th scope="col">{t("auditColumnIntegrity")}</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => <tr key={event.id}>
            <td><time className="mono" dateTime={event.createdAt}>{formatAuditTime(event.createdAt)}</time></td>
            <td>
              <code className="mono">{event.action}</code>
              {event.simulated && <span className="audit-simulation" lang="en">{t("auditSimulationLabel")}</span>}
            </td>
            <td><code className="mono">{event.entity}</code></td>
            <td><code className="mono">{event.actor}</code></td>
            <td>{t(`classifications.${event.classification}`)}</td>
            <td>
              <details className="audit-hashes">
                <summary>{t("auditShowHashes")}</summary>
                <dl>
                  <dt>{t("auditHash")}</dt><dd className="mono">{event.hash}</dd>
                  <dt>{t("auditPrevHash")}</dt><dd className="mono">{event.prevHash ?? t("auditChainStart")}</dd>
                  <dt>{t("auditBeforeHash")}</dt><dd className="mono">{event.beforeHash ?? t("notRecorded")}</dd>
                  <dt>{t("auditAfterHash")}</dt><dd className="mono">{event.afterHash ?? t("notRecorded")}</dd>
                </dl>
              </details>
            </td>
          </tr>)}
        </tbody>
      </table>
    </div>}
    {hasMore && onLoadMore && <Button type="button" variant="secondary" loading={isLoadingMore} onClick={onLoadMore}>{t("auditLoadMore")}</Button>}
  </main>;
}
