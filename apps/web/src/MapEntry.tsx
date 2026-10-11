import { useTranslation } from "react-i18next";

export function MapEntry() {
  const { t } = useTranslation();
  return <main id="main-content" className="map-entry" tabIndex={-1}>
    <div className="view-heading"><h1>{t("map")}</h1><p>{t("mapDetail")}</p></div>
    <section className="map-pending" aria-label={t("map")}>
      <h2>{t("mapPending")}</h2>
    </section>
  </main>;
}
