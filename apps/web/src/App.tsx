import { SimulationBanner } from "./SimulationBanner";
import { lazy, Suspense, useLayoutEffect } from "react";
import { Outlet } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { SessionGate } from "./SessionGate";
import { AccountSwitcher } from "./AccountSwitcher";
import { usePreferences } from "./preferences";
import type { CurrentUser } from "./api-client";

const SimulationControls = lazy(() => import("./SimulationControls").then(({ SimulationControls }) => ({ default: SimulationControls })));

export function App() {
  return <SessionGate>{(user) => <SignedInWorkspace user={user} />}</SessionGate>;
}

function SignedInWorkspace({ user }: { user: CurrentUser }) {
  const { t, i18n } = useTranslation();
  const { language, nightShift, toggleLanguage, toggleNightShift } = usePreferences();
  useLayoutEffect(() => {
    usePreferences.getState().loadUserLanguage(user.orgId, user.sub);
  }, [user.orgId, user.sub]);
  useLayoutEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dataset["theme"] = nightShift ? "dark" : "light";
    void i18n.changeLanguage(language);
  }, [language, nightShift, i18n]);

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">{t("skip")}</a>
    <header className="top-bar">
      <a href="/map" className="wordmark" aria-label="FieldLoop-v2">FieldLoop-<span>v2</span></a>
      <div className="preferences">
        <AccountSwitcher user={user} />
        <button type="button" onClick={toggleLanguage} lang={language === "en" ? "th" : "en"} aria-label={t(language === "en" ? "languageThai" : "languageEnglish")}>{t("languageToggle")}</button>
        <button onClick={toggleNightShift} aria-pressed={nightShift}>{t("nightShift")}</button>
      </div>
    </header>
    <SimulationBanner />
    <Outlet />
    <Suspense fallback={<p className="simulation-controls" role="status">{t("simulationLoading")}</p>}><SimulationControls user={user} /></Suspense>
  </div>;
}
