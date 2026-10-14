import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { HealthBadge } from "@fieldloop/ui";
import { useTranslation } from "react-i18next";
import { api } from "./api-client";
import type { components } from "@fieldloop/contracts";

type BowtieCanvas = components["schemas"]["BowtieCanvas"];
type RiskExplain = components["schemas"]["RiskExplain"];

class ApiQueryError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export function BowtieCanvasPage() {
  const { bowtieId } = useParams({ from: "/bowties/$bowtieId" });
  const { t, i18n } = useTranslation();
  const [explainOpen, setExplainOpen] = useState(false);
  const canvas = useQuery({
    queryKey: ["bowtie", bowtieId, "canvas"],
    queryFn: async ({ signal }) => readResult(await api.GET("/v1/bowties/{bowtieId}", { params: { path: { bowtieId } }, signal })),
    retry: false,
  });
  const risk = useQuery({
    queryKey: ["bowtie", bowtieId, "risk"],
    queryFn: async ({ signal }) => readResult(await api.GET("/v1/bowties/{bowtieId}/risk", { params: { path: { bowtieId } }, signal })),
    retry: false,
  });
  const explain = useQuery({
    queryKey: ["bowtie", bowtieId, "risk", "explain"],
    queryFn: async ({ signal }) => readResult(await api.GET("/v1/bowties/{bowtieId}/risk/explain", { params: { path: { bowtieId } }, signal })),
    enabled: explainOpen,
    retry: false,
  });
  const data = canvas.data;
  const barriers = new Map(data?.barriers.map((barrier) => [barrier.id, barrier]) ?? []);
  const errorCode = (error: unknown) => error instanceof ApiQueryError ? error.code : "";

  return <main id="main-content" className="bowtie-page" tabIndex={-1}>
    <nav className="bowtie-navigation" aria-label={t("bowtieNavigation")}>
      <Link to="/map">{t("backToMap")}</Link>
    </nav>
    {canvas.isPending ? <p role="status">{t("loadingBowtie")}</p> : null}
    {canvas.isError ? <p role="alert">{t("bowtieUnavailable")}</p> : null}
    {data ? <>
      <header className="bowtie-heading">
        <p className="eyebrow">{data.simulated ? t("simulatedData") : t("syntheticData")}</p>
        <h1 lang="en">{data.topEvent}</h1>
        <p lang="en">{data.hazard}</p>
        <span className="mono">{data.id}</span>
      </header>
      {risk.isError && errorCode(risk.error) === "risk_matrix_unconfigured" ? <section className="risk-calibration-notice" role="status">
        <h2>{t("riskCalibrationPending")}</h2>
        <p>{t("riskCalibrationPendingDetail")}</p>
      </section> : null}
      {risk.isError && errorCode(risk.error) !== "risk_matrix_unconfigured" ? <p role="alert">{t("riskUnavailable")}</p> : null}
      <div className="bowtie-score-strip">
        {risk.data ? <>
          <div><span>{t("riskScore")}</span><strong className={`risk-zone risk-zone-${risk.data.snapshot.cell.zone}`}>{t(`riskZone.${risk.data.snapshot.cell.zone}`)}</strong></div>
          <div><span>{t("topEventFrequency")}</span><strong className="mono">{risk.data.snapshot.topEventFrequencyPerYear.toExponential(3)} / {t("year")}</strong></div>
          <div><span>{t("worstConsequence")}</span><strong className="mono">{risk.data.snapshot.worstConsequenceId}</strong></div>
        </> : null}
        <button type="button" onClick={() => setExplainOpen(true)}>{t("explainScore")}</button>
      </div>
      <div className="bowtie-canvas" aria-label={t("bowtieCanvas")}>
        <section className="bowtie-column" aria-labelledby="threats-title">
          <h2 id="threats-title">{t("threatsAndPrevention")}</h2>
          {data.threats.map((threat) => {
            const path = data.paths.find((item) => item.side === "preventive" && item.targetId === threat.id);
            return <article className="bowtie-path" key={threat.id}>
              <h3 lang="en">{threat.name}</h3>
              <p className="mono">{t("frequencyPerYear", { value: threat.frequencyPerYear.toExponential(3) })}</p>
              <p className="mono">{threat.id}</p>
              {path?.barrierIds.map((barrierId) => {
                const barrier = barriers.get(barrierId);
                return barrier ? <BarrierCell key={barrierId} barrier={barrier} t={t} /> : null;
              })}
            </article>;
          })}
        </section>
        <section className="bowtie-top-event-panel" aria-labelledby="top-event-title">
          <h2 id="top-event-title">{t("topEvent")}</h2>
          <p>{data.topEvent}</p>
          {risk.data ? <dl>
            <dt>{t("frequencyPerYearLabel")}</dt><dd className="mono">{risk.data.snapshot.topEventFrequencyPerYear.toExponential(3)}</dd>
            <dt>{t("riskZoneLabel")}</dt><dd>{t(`riskZone.${risk.data.snapshot.cell.zone}`)}</dd>
            <dt>{t("snapshotTime")}</dt><dd className="mono"><time dateTime={risk.data.createdAt}>{new Date(risk.data.createdAt).toLocaleString(i18n.language === "th" ? "th-TH" : "en-GB", { timeZone: "Asia/Bangkok" })}</time></dd>
          </dl> : null}
        </section>
        <section className="bowtie-column" aria-labelledby="consequences-title">
          <h2 id="consequences-title">{t("mitigationAndConsequences")}</h2>
          {data.consequences.map((consequence) => {
            const path = data.paths.find((item) => item.side === "mitigative" && item.targetId === consequence.id);
            const riskResult = risk.data?.snapshot.consequences.find((item) => item.consequenceId === consequence.id);
            return <article className="bowtie-path" key={consequence.id}>
              <h3 lang="en">{consequence.name}</h3>
              <p className="mono">{consequence.id}</p>
              <ul className="severity-list">
                {Object.entries(consequence.severity).map(([dimension, band]) => {
                  const definition = data.severityCriteria?.[dimension as keyof NonNullable<BowtieCanvas["severityCriteria"]>]?.[band - 1];
                  return <li key={dimension}><span>{t(`severityDimension.${dimension}`, { defaultValue: dimension })}</span><span className="mono">{band}</span>{definition ? <span lang="en">{definition}</span> : null}</li>;
                })}
              </ul>
              {riskResult ? <p className="consequence-risk"><span className={`risk-zone risk-zone-${riskResult.cell.zone}`}>{t(`riskZone.${riskResult.cell.zone}`)}</span> <span className="mono">{riskResult.frequencyPerYear.toExponential(3)} / {t("year")}</span></p> : null}
              {path?.barrierIds.map((barrierId) => {
                const barrier = barriers.get(barrierId);
                return barrier ? <BarrierCell key={barrierId} barrier={barrier} t={t} /> : null;
              })}
            </article>;
          })}
        </section>
      </div>
      {explainOpen ? <aside className="explain-drawer" aria-labelledby="explain-title" aria-live="polite">
        <div className="explain-drawer-header">
          <div><p className="eyebrow">{t("riskScore")}</p><h2 id="explain-title">{t("explainScore")}</h2></div>
          <button type="button" className="button-secondary" onClick={() => setExplainOpen(false)}>{t("close")}</button>
        </div>
        {explain.isPending ? <p role="status">{t("loadingExplanation")}</p> : null}
        {explain.isError && errorCode(explain.error) === "risk_matrix_unconfigured" ? <p role="status">{t("riskCalibrationPendingDetail")}</p> : null}
        {explain.isError && errorCode(explain.error) !== "risk_matrix_unconfigured" ? <p role="alert">{t("explanationUnavailable")}</p> : null}
        {explain.data ? <ExplanationPanel explanation={explain.data} t={t} /> : null}
      </aside> : null}
    </> : null}
  </main>;
}

function BarrierCell({ barrier, t }: { barrier: BowtieCanvas["barriers"][number]; t: ReturnType<typeof useTranslation>["t"] }) {
  const typeLabel = t(`barrierType.${barrier.type}`);
  return <div className="barrier-cell">
    <div className="barrier-cell-heading"><strong lang="en">{barrier.name}</strong><HealthBadge health={barrier.health} label={t(`barrierHealth.${barrier.health}`)} /></div>
    <p className="mono">{barrier.id}</p>
    <p>{typeLabel} · {t("pfdBand")} <span className="mono">{barrier.pfdBand.toExponential(2)}</span></p>
    {barrier.degradationFactors.map((factor) => <p className="degradation-factor" key={factor}>{t("degradationFactor")}: {factor}</p>)}
  </div>;
}

function ExplanationPanel({ explanation, t }: { explanation: RiskExplain; t: ReturnType<typeof useTranslation>["t"] }) {
  return <>
    <p lang="en">{explanation.summary}</p>
    {explanation.hasPrevious && explanation.previous ? <div className="snapshot-comparison">
      <div>
        <span>{t("previousSnapshot")}</span><strong className="mono">{explanation.previous.snapshot.topEventFrequencyPerYear.toExponential(3)}</strong>
        <span>{t(`riskZone.${explanation.previous.snapshot.cell.zone}`)}</span>
        <time className="mono" dateTime={explanation.previous.createdAt}>{new Date(explanation.previous.createdAt).toISOString()}</time>
        <CalibrationProvenance calibration={explanation.previous.calibration} t={t} />
      </div>
      <div>
        <span>{t("currentSnapshot")}</span><strong className="mono">{explanation.current.snapshot.topEventFrequencyPerYear.toExponential(3)}</strong>
        <span>{t(`riskZone.${explanation.current.snapshot.cell.zone}`)}</span>
        <time className="mono" dateTime={explanation.current.createdAt}>{new Date(explanation.current.createdAt).toISOString()}</time>
        <CalibrationProvenance calibration={explanation.current.calibration} t={t} />
      </div>
    </div> : <p className="no-prior-snapshot">{t("noPriorSnapshot")}</p>}
    {explanation.changes.length ? <ol className="risk-change-list">{explanation.changes.map((change) => <li key={change.barrierId}>
      <h3>{t("barrierChange")}</h3>
      <p className="mono">{change.barrierId}</p>
      <p>{t("healthChange", { before: t(`barrierHealth.${change.beforeHealth}`), after: t(`barrierHealth.${change.afterHealth}`) })}</p>
      <p lang="en">{change.reason}</p>
      <dl>
        <dt>{t("topEventFrequencyDelta")}</dt><dd className="mono">{change.topEventFrequencyDeltaPerYear.toExponential(3)} / {t("year")}</dd>
        <dt>{t("impactOrder")}</dt><dd className="mono">{change.impact.toExponential(3)}</dd>
      </dl>
      {change.consequenceFrequencyDeltasPerYear.map((delta) => <p className="mono" key={delta.consequenceId}>{delta.consequenceId}: {delta.delta.toExponential(3)} / {t("year")}</p>)}
      {change.sourceEvidenceHref ? <a href={change.sourceEvidenceHref}>{t("openSourceEvidence")} <span className="mono">{change.sourceEvidenceId}</span></a> : <p>{t("noSourceEvidence")}</p>}
    </li>)}</ol> : explanation.hasPrevious ? <p>{t("noInputChanges")}</p> : null}
    {explanation.riskInputChanges.length ? <section aria-label={t("otherRiskInputs")}>
      <h3>{t("otherRiskInputs")}</h3>
      <ol className="risk-change-list">{explanation.riskInputChanges.map((change) => <li key={change.path}>
        <p className="mono">{change.path}</p>
        <p className="mono">{change.beforeValue ?? "—"} → {change.afterValue ?? "—"}</p>
      </li>)}</ol>
    </section> : null}
  </>;
}

function CalibrationProvenance({ calibration, t }: {
  calibration: components["schemas"]["RiskCalibration"];
  t: ReturnType<typeof useTranslation>["t"];
}) {
  return <dl className="risk-calibration-provenance">
    <dt>{t("riskStandardRef")}</dt><dd className="mono">{calibration.standardRef}</dd>
    <dt>{t("riskStandardVersion")}</dt><dd className="mono">{calibration.standardVersion}</dd>
    <dt>{t("riskCalibrationApprovedBy")}</dt><dd className="mono">{calibration.approvedBy}</dd>
    <dt>{t("riskCalibrationApprovedAt")}</dt><dd><time className="mono" dateTime={calibration.approvedAt}>{calibration.approvedAt}</time></dd>
  </dl>;
}

async function readResult<T>(result: { response: Response; data?: T; error?: unknown }): Promise<T> {
  if (result.response.ok && result.data !== undefined) return result.data;
  let code = "request_failed";
  let problem = result.error;
  if (problem === undefined) {
    try { problem = await result.response.clone().json(); }
    catch { /* Empty and non-JSON errors stay generic. */ }
  }
  if (problem && typeof problem === "object" && "code" in problem && typeof problem.code === "string") code = problem.code;
  throw new ApiQueryError(result.response.status, code);
}
