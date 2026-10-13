import { useTranslation } from "react-i18next";
import { useSimulation } from "./useSimulation";

export function SimulationBanner() {
  const { t } = useTranslation();
  const { data: run } = useSimulation();
  return <div className="workspace-banner" role="region" aria-label={t("simulationWorkspace")}>
    {run ? <><span lang="en">SIMULATION</span> · {t("scenario")}: <span lang="en">{run.scenarioName}</span> · <span className="mono">{run.speed}×</span></> : t("workspace")}
  </div>;
}
