import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { BowtieCanvas } from "./BowtieCanvas";
import { getBowtie } from "./bowtie-data";

export function BowtieEntry() {
  const { bowtieId } = useParams({ from: "/bowtie/$bowtieId" });
  const search = useSearch({ from: "/bowtie/$bowtieId" });
  const navigate = useNavigate({ from: "/bowtie/$bowtieId" });
  const { t } = useTranslation();
  const bowtie = getBowtie(bowtieId);

  if (!bowtie) {
    return <main id="main-content" className="bowtie-screen" tabIndex={-1} aria-labelledby="bowtie-title">
      <button type="button" className="bowtie-back-button" onClick={() => { void navigate(mapReturnLocation(search)); }}>{t("backToMap")}</button>
      <h1 id="bowtie-title">{t("bowtieUnavailable")}</h1>
      <p>{t("bowtieUnavailableDetail")}</p>
    </main>;
  }

  return <BowtieCanvas bowtie={bowtie} onBack={() => { void navigate(mapReturnLocation(search)); }} />;
}

export function mapReturnLocation(search: Record<string, unknown>) {
  return { to: "/map" as const, search };
}
