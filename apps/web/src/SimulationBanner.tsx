import { useTranslation } from "react-i18next";
import { useSimulation } from "./useSimulation";
import { useHasVisibleSimulatedData } from "./useVisibleSimulation";

export function SimulationBanner() {
  const { t } = useTranslation();
  const { data: run } = useSimulation();
  const hasVisibleSimulatedData = useHasVisibleSimulatedData();
  const showSimulation = Boolean(run) || hasVisibleSimulatedData;
  return <div className="workspace-banner" role="region" aria-label={t(showSimulation ? "simulationWorkspace" : "workspace")}>
    {run ? <><span lang="en">SIMULATION</span> · {t("scenario")}: <span lang="en">{run.scenarioName}</span> · <span className="mono">{run.speed}×</span></>
      : hasVisibleSimulatedData ? <><span lang="en">SIMULATION</span> · {t("simulatedData")}</> : t("workspace")}
  </div>;
}
