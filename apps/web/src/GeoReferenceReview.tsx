import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { decideGeoReference, geoReferenceDraftsQueryKey, getGeoReferenceDrafts, type GeoReference } from "./geo-references";
import { useCurrentSession } from "./SessionGate";

interface TargetAsset {
  id: string;
  name: string;
  type: "linear" | "asset";
}

export function GeoReferenceReview({ targetAssets }: { targetAssets: TargetAsset[] }) {
  const { t, i18n } = useTranslation();
  const session = useCurrentSession();
  const queryClient = useQueryClient();
  const drafts = useQuery({
    queryKey: geoReferenceDraftsQueryKey,
    queryFn: ({ signal }) => getGeoReferenceDrafts(signal),
    retry: 1,
  });
  const [selectedTargets, setSelectedTargets] = useState<Record<string, string>>({});
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const canDecide = Boolean(session.data?.roles.some((role) => role === "fieldloop.operator" || role === "fieldloop.manager"));

  const decide = async (reference: GeoReference, decision: "confirm" | "reject") => {
    if (!session.data) return;
    setPendingId(reference.id);
    setError(false);
    try {
      await decideGeoReference({
        geoReferenceId: reference.id,
        decision,
        ...(decision === "confirm" && selectedTargets[reference.id] ? { targetAssetId: selectedTargets[reference.id] } : {}),
        csrfToken: session.data.csrfToken,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: geoReferenceDraftsQueryKey }),
        queryClient.invalidateQueries({ queryKey: ["map-layer", "geo-references"] }),
      ]);
    } catch {
      setError(true);
    } finally {
      setPendingId(null);
    }
  };

  const items = drafts.data?.items ?? [];
  return <section className="geo-reference-section" aria-labelledby="geo-reference-heading" lang={i18n.resolvedLanguage ?? i18n.language}>
    <div className="geo-reference-heading">
      <h3 id="geo-reference-heading">{t("geoReferenceReview.title")}</h3>
      {items.length > 0 && <span className="mono" aria-label={t("geoReferenceReview.draftCount", { count: items.length })}>{items.length}</span>}
    </div>
    <p className="context-summary-scope">{t("geoReferenceReview.description")}</p>
    {drafts.isPending && <p role="status" className="geo-reference-empty">{t("geoReferenceReview.loading")}</p>}
    {drafts.isError && <p role="alert" className="geo-reference-error">{t("geoReferenceReview.loadError")}</p>}
    {error && <p role="alert" className="geo-reference-error">{t("geoReferenceReview.decisionError")}</p>}
    {!drafts.isPending && !drafts.isError && items.length === 0 && <p className="geo-reference-empty">{t("geoReferenceReview.empty")}</p>}
    <ul className="geo-reference-list">
      {items.map((reference) => {
        const requiresAsset = reference.geometry === null && (reference.kind === "chainage" || reference.kind === "asset");
        const options = targetAssets.filter((asset) => reference.kind !== "chainage" || asset.type === "linear");
        const selectedAsset = selectedTargets[reference.id] ?? "";
        const needsSelection = requiresAsset && !selectedAsset;
        const coordinates = reference.geometry?.type === "Point" ? reference.geometry.coordinates : null;
        return <li className="geo-reference-row" key={reference.id}>
          <div className="geo-reference-row-heading">
            <strong>{reference.proposedLabel ?? reference.documentTitle}</strong>
            {reference.simulated && <span className="health-proposal-simulation" lang="en">SIMULATION</span>}
          </div>
          <p className="geo-reference-source">{t("geoReferenceReview.fromDocument", { title: reference.documentTitle })}</p>
          <p className="geo-reference-snippet">“{reference.sourceSnippet}”</p>
          <dl className="geo-reference-metadata">
            <div><dt>{t("geoReferenceReview.type")}</dt><dd>{t(`geoReferenceReview.kinds.${reference.kind}`)}</dd></div>
            <div><dt>{t("geoReferenceReview.confidence")}</dt><dd className="mono">{new Intl.NumberFormat(i18n.language === "th" ? "th-TH" : "en-GB", { style: "percent", maximumFractionDigits: 0 }).format(reference.confidence)}</dd></div>
            {reference.chainageFrom !== null && <div><dt>{t("chainage")}</dt><dd className="mono">{formatMetres(reference.chainageFrom)}–{formatMetres(reference.chainageTo ?? reference.chainageFrom)} m</dd></div>}
            {Array.isArray(coordinates) && <div><dt>{t("geoReferenceReview.coordinates")}</dt><dd className="mono">{Number(coordinates[1]).toFixed(5)}, {Number(coordinates[0]).toFixed(5)}</dd></div>}
            <div><dt>{t("classification")}</dt><dd className="mono">{reference.classification}</dd></div>
          </dl>
          {requiresAsset && <label className="geo-reference-target-label">
            <span>{t(reference.kind === "chainage" ? "geoReferenceReview.chooseLinearAsset" : "geoReferenceReview.chooseAsset")}</span>
            <select
              value={selectedAsset}
              aria-label={t(reference.kind === "chainage" ? "geoReferenceReview.chooseLinearAsset" : "geoReferenceReview.chooseAsset")}
              onChange={(event) => setSelectedTargets((current) => ({ ...current, [reference.id]: event.target.value }))}
              disabled={!canDecide || pendingId === reference.id || options.length === 0}
            >
              <option value="">{t("geoReferenceReview.selectAssetPlaceholder")}</option>
              {options.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
            </select>
            {options.length === 0 && <span className="geo-reference-empty">{t("geoReferenceReview.noAssets")}</span>}
          </label>}
          {canDecide ? <div className="geo-reference-actions">
            <button type="button" className="geo-reference-confirm" onClick={() => { void decide(reference, "confirm"); }}
              disabled={pendingId === reference.id || needsSelection}>
              {t(pendingId === reference.id ? "geoReferenceReview.saving" : "geoReferenceReview.confirm")}
            </button>
            <button type="button" onClick={() => { void decide(reference, "reject"); }} disabled={pendingId === reference.id}>
              {t("geoReferenceReview.reject")}
            </button>
          </div> : <p className="geo-reference-empty">{t("geoReferenceReview.readOnly")}</p>}
        </li>;
      })}
    </ul>
  </section>;
}

function formatMetres(value: number): string {
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 }).format(value);
}
