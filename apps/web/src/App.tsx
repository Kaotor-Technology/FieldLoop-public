import { useEffect } from "react";
import { Outlet } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { SessionGate } from "./SessionGate";
import { AccountSwitcher } from "./AccountSwitcher";
import { usePreferences } from "./preferences";

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
        <button onClick={toggleLanguage} lang={language === "en" ? "th" : "en"}>{language === "en" ? "ภาษาไทย" : "English"}</button>
        <button onClick={toggleNightShift} aria-pressed={nightShift}>{t("nightShift")}</button>
      </div>
    </header>
    <div className="workspace-banner">{t("workspace")}</div>
    <div className="console-layout">
      <Outlet />
      <aside className="identity-panel" aria-label={t("identity")}>
        <h2>{t("identity")}</h2>
        <dl>
          <dt>{t("persona")}</dt><dd lang="en">{user.persona}</dd>
          <dt>{t("roles")}</dt><dd className="mono">{user.roles.join(", ")}</dd>
          <dt>{t("subject")}</dt><dd className="mono">{user.sub}</dd>
          <dt>{t("authTime")}</dt><dd className="mono"><time dateTime={user.authTime}>{new Date(user.authTime).toLocaleString(language === "en" ? "en-GB" : "th-TH", { timeZone: "Asia/Bangkok" })}</time></dd>
        </dl>
        <AccountSwitcher user={user} />
      </aside>
    </div>
  </>}</SessionGate>;
}
