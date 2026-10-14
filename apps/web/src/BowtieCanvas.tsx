import { HealthBadge } from "@fieldloop/ui";
import type { BarrierHealth } from "@fieldloop/ui";
import { useTranslation } from "react-i18next";
import type { BowtieView, TriadDimension } from "./bowtie-data";
import { monoNumericText } from "./mono-numeric-text";

interface BowtieCanvasProps {
  bowtie: BowtieView;
  onBack: () => void;
}

const TRIAD_DIMENSIONS: readonly TriadDimension[] = ["effective", "independent", "auditable"];

export function BowtieCanvas({ bowtie, onBack }: BowtieCanvasProps) {
  const { t } = useTranslation();
  const seenBarrierIds = new Set<string>();
  const barriers = bowtie.barriers.filter((barrier) => {
    if (seenBarrierIds.has(barrier.id)) return false;
    seenBarrierIds.add(barrier.id);
    return true;
  });
  const preventive = barriers.filter((barrier) => barrier.side === "preventive");
  const mitigative = barriers.filter((barrier) => barrier.side === "mitigative");

  return <main id="main-content" className="bowtie-screen" tabIndex={-1} aria-labelledby="bowtie-title">
    <header className="bowtie-header">
      <button type="button" className="bowtie-back-button" onClick={onBack}>{t("backToMap")}</button>
      <div>
        <p className="eyebrow">{t("readOnlyView")} · {t("bowtieCode", { code: bowtie.code })}</p>
        <h1 id="bowtie-title" lang="en">{monoNumericText(bowtie.title)}</h1>
      </div>
      <span className="bowtie-provenance" lang="en">{bowtie.provenance}</span>
    </header>

    <div className="bowtie-canvas-viewport" role="region" aria-label={t("bowtieCanvas")}>
      <div className="bowtie-canvas">
        <section className="bowtie-column bowtie-centre-column" aria-labelledby="bowtie-centre-heading">
          <h2 id="bowtie-centre-heading">{t("hazard")}</h2>
          <p className="bowtie-hazard" lang="en">{monoNumericText(bowtie.hazard)}</p>
          <h2>{t("topEvent")}</h2>
          <p className="bowtie-top-event" lang="en">{monoNumericText(bowtie.topEvent)}</p>
          <dl className="bowtie-metadata">
            <div><dt>{t("domain")}</dt><dd lang="en">{monoNumericText(bowtie.domain)}</dd></div>
            <div><dt>{t("classification")}</dt><dd>{monoNumericText(bowtie.classification)}</dd></div>
          </dl>
        </section>

        <section className="bowtie-column bowtie-left-column" aria-labelledby="bowtie-left-heading">
          <h2 id="bowtie-left-heading">{t("threats")}</h2>
          <ul className="bowtie-entity-list">
            {bowtie.threats.map((threat) => <li key={threat.id} lang="en">{monoNumericText(threat.name)}</li>)}
          </ul>
          <h2>{t("preventiveBarriers")}</h2>
          <ul className="bowtie-barrier-list">
            {preventive.map((barrier) => <li key={barrier.id}><BarrierCard barrier={barrier} /></li>)}
          </ul>
        </section>

        <section className="bowtie-column bowtie-right-column" aria-labelledby="bowtie-right-heading">
          <h2 id="bowtie-right-heading">{t("mitigativeBarriers")}</h2>
          <ul className="bowtie-barrier-list">
            {mitigative.map((barrier) => <li key={barrier.id}><BarrierCard barrier={barrier} /></li>)}
          </ul>
          <h2>{t("consequences")}</h2>
          <ul className="bowtie-entity-list">
            {bowtie.consequences.map((consequence) => <li key={consequence.id} lang="en">{consequence.name}</li>)}
          </ul>
        </section>
      </div>
    </div>

    <section className="bowtie-groups" aria-labelledby="bowtie-groups-heading">
      <h2 id="bowtie-groups-heading">{t("independenceGroups")}</h2>
      {bowtie.independenceGroups.length === 0
        ? <p>{t("noIndependenceGroups")}</p>
        : <ul>{bowtie.independenceGroups.map((group) => <li key={group.id}>
          <strong lang="en">{monoNumericText(group.cause)}</strong>
          {group.barrierIds.length > 0 && <span>{t("sharedByBarriers")}: {monoNumericText(group.barrierIds.map((id) => findBarrierName(bowtie, id)).join(", "))}</span>}
        </li>)}</ul>}
    </section>

    <details className="bowtie-text-equivalent">
      <summary>{t("textEquivalent")}</summary>
      <div>
        <p><strong>{t("bowtieCode", { code: bowtie.code })} · {t("readOnlyView")}:</strong> <span lang="en">{monoNumericText(bowtie.title)}</span></p>
        <p><strong>{t("provenance")}:</strong> <span lang="en">{bowtie.provenance}</span></p>
        <p><strong>{t("hazard")}:</strong> <span lang="en">{monoNumericText(bowtie.hazard)}</span></p>
        <p><strong>{t("topEvent")}:</strong> <span lang="en">{monoNumericText(bowtie.topEvent)}</span></p>
        <p><strong>{t("domain")}:</strong> <span lang="en">{monoNumericText(bowtie.domain)}</span></p>
        <p><strong>{t("classification")}:</strong> <span lang="en">{monoNumericText(bowtie.classification)}</span></p>
        <h3>{t("threats")}</h3>
        <ul>{bowtie.threats.map((threat) => <li key={threat.id} lang="en">{monoNumericText(threat.name)}</li>)}</ul>
        <h3>{t("barriers")}</h3>
        <ul>{barriers.map((barrier) => <li key={barrier.id}>
          <strong lang="en">{monoNumericText(barrier.name)}</strong> · {t("barrierTypeLabel")}: {t(barrier.type)} · {t(barrier.side)} · {t(`barrierHealth.${barrier.health}`)}
          {barrier.pathNames.length > 0 && <span className="bowtie-path-membership"> · {t("pathMembership")}: <span lang="en">{monoNumericText(barrier.pathNames.join(", "))}</span></span>}
          {barrier.degradationFactors.length === 0
            ? <> · {t("noDegradationFactors")}</>
            : barrier.degradationFactors.map((factor) => <span key={factor.id}> · {t("degradationFactor")}: <span lang="en">{monoNumericText(factor.description)}</span>
              {factor.controls.length > 0 && <> · {t("degradationControl")}: <span lang="en">{monoNumericText(factor.controls.join(", "))}</span></>}
            </span>)}
          <TriadText barrier={barrier} />
        </li>)}</ul>
        <h3>{t("consequences")}</h3>
        <ul>{bowtie.consequences.map((consequence) => <li key={consequence.id} lang="en">{monoNumericText(consequence.name)}</li>)}</ul>
        <h3>{t("independenceGroups")}</h3>
        {bowtie.independenceGroups.length === 0
          ? <p>{t("noIndependenceGroups")}</p>
          : <ul>{bowtie.independenceGroups.map((group) => <li key={group.id}>
            {monoNumericText(group.cause)}
            {group.barrierIds.length > 0 && <span> · {t("sharedByBarriers")}: {monoNumericText(group.barrierIds.map((id) => findBarrierName(bowtie, id)).join(", "))}</span>}
          </li>)}</ul>}
      </div>
    </details>
  </main>;
}

function BarrierCard({ barrier }: { barrier: BowtieView["barriers"][number] }) {
  const { t } = useTranslation();
  return <article className="bowtie-barrier-card">
    <div className="bowtie-barrier-heading">
      <strong lang="en">{monoNumericText(barrier.name)}</strong>
      <HealthBadge health={barrier.health as BarrierHealth} label={t(`barrierHealth.${barrier.health}`)} />
    </div>
    <p className="bowtie-barrier-type">{t("barrierTypeLabel")}: {t(barrier.type)}</p>
    {barrier.pathNames.length > 0 && <p className="bowtie-path-membership">{t("pathMembership")}: <span lang="en">{monoNumericText(barrier.pathNames.join(", "))}</span></p>}
    <section className="bowtie-degradation" aria-label={t("degradationFactors")}>
      <h3>{t("degradationFactors")}</h3>
      {barrier.degradationFactors.length === 0
        ? <p>{t("noDegradationFactors")}</p>
        : <ul>{barrier.degradationFactors.map((factor) => <li key={factor.id}>
          <span lang="en">{monoNumericText(factor.description)}</span>
          {factor.controls.length > 0 && <small>{t("degradationControl")}: <span lang="en">{monoNumericText(factor.controls.join(", "))}</span></small>}
        </li>)}</ul>}
    </section>
    <details className="bowtie-triad">
      <summary>{t("validationTriad")}</summary>
      {TRIAD_DIMENSIONS.some((dimension) => barrier.triad[dimension])
        ? <dl>{TRIAD_DIMENSIONS.map((dimension) => {
          const result = barrier.triad[dimension];
          return result ? <div key={dimension}>
            <dt>{t(dimension)}</dt>
            <dd><span>{t(result.pass ? "pass" : "fail")}</span>{result.justification ? <> · <span lang="en">{monoNumericText(result.justification)}</span></> : ""}</dd>
          </div> : null;
        })}</dl>
        : <p>{t("notRecorded")}</p>}
    </details>
  </article>;
}

function TriadText({ barrier }: { barrier: BowtieView["barriers"][number] }) {
  const { t } = useTranslation();
  const results = TRIAD_DIMENSIONS.flatMap((dimension) => {
    const result = barrier.triad[dimension];
    return result ? [monoNumericText(t(dimension) + ": " + t(result.pass ? "pass" : "fail") + (result.justification ? " — " + result.justification : ""))] : [];
  });
  return <span> · {t("validationTriad")}: {results.length > 0 ? results.map((result, index) => <span key={index}>{index > 0 ? "; " : ""}{result}</span>) : t("notRecorded")}</span>;
}

function findBarrierName(bowtie: BowtieView, barrierId: string): string {
  return bowtie.barriers.find((barrier) => barrier.id === barrierId)?.name ?? barrierId;
}
