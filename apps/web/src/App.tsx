import { SimulationBanner } from "./SimulationBanner";
import { lazy, Suspense, useEffect } from "react";
import { Outlet } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { SessionGate } from "./SessionGate";
import { AccountSwitcher } from "./AccountSwitcher";
import { usePreferences } from "./preferences";

const SimulationControls = lazy(() => import("./SimulationControls").then(({ SimulationControls }) => ({ default: SimulationControls })));

export function App() {
  const { t, i18n } = useTranslation();
  const { language, nightShift, toggleLanguage, toggleNightShift } = usePreferences();
  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dataset["theme"] = nightShift ? "dark" : "light";
    void i18n.changeLanguage(language);
  }, [language, nightShift, i18n]);

  return <SessionGate>{(user) => <>
    <a className="skip-link" href="#main-content">{t("skip")}</a>
    <header className="top-bar">
      <a href="/map" className="wordmark" aria-label="FieldLoop">Field<span>Loop</span></a>
      <div className="preferences">
        <AccountSwitcher user={user} />
        <button onClick={toggleLanguage} lang={language === "en" ? "th" : "en"}>{language === "en" ? "ภาษาไทย" : "English"}</button>
        <button onClick={toggleNightShift} aria-pressed={nightShift}>{t("nightShift")}</button>
      </div>
    </header>
    <SimulationBanner />
    <Outlet />
    <Suspense fallback={<p className="simulation-controls" role="status">{t("simulationLoading")}</p>}><SimulationControls user={user} /></Suspense>
  </>}</SessionGate>;
}
