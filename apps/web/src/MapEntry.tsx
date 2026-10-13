import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api, SessionError } from "./api-client";

export function MapEntry() {
  const { t } = useTranslation();
  const bowties = useQuery({
    queryKey: ["bowtie", "list"],
    queryFn: async ({ signal }) => {
      const { data, response } = await api.GET("/v1/bowties", { signal });
      if (!response.ok || data === undefined) throw new SessionError(response.status);
      return data;
    },
    retry: false,
  });
  return <main id="main-content" className="map-entry" tabIndex={-1}>
    <div className="view-heading"><h1>{t("map")}</h1><p>{t("mapDetail")}</p></div>
    <section className="bowtie-list" aria-labelledby="bowtie-list-title">
      <h2 id="bowtie-list-title">{t("bowties")}</h2>
      {bowties.isPending ? <p role="status">{t("loadingBowties")}</p> : null}
      {bowties.isError ? <p role="alert">{t("bowtiesUnavailable")}</p> : null}
      {bowties.data?.length ? <ul>{bowties.data.map((bowtie) => <li key={bowtie.id}>
        <Link to="/bowties/$bowtieId" params={{ bowtieId: bowtie.id }}>
          <strong>{bowtie.topEvent}</strong>
          <span>{bowtie.hazard}</span>
          <span className="mono">{bowtie.id}</span>
          <span className="simulation-label">{bowtie.simulated ? t("simulatedData") : t("syntheticData")}</span>
        </Link>
      </li>)}</ul> : !bowties.isPending && !bowties.isError ? <p>{t("noBowties")}</p> : null}
    </section>
    <section className="map-pending" aria-label={t("map")}>
      <h2>{t("mapPending")}</h2>
    </section>
  </main>;
}
