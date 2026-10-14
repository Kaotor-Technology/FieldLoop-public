import { afterEach, describe, expect, it } from "vitest";
import { createInstance } from "i18next";
import type { BarrierType, RiskBarrier, RiskSeverity, RiskZone } from "@fieldloop/contracts";
import type { MapFeatureProperties } from "@fieldloop/map";
import type { BowtieView, TriadDimension } from "./bowtie-data";
import i18n from "./i18n";

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("demo localisation", () => {
  it("starts in English and falls back to English for unsupported languages", async () => {
    expect(i18n.language).toBe("en");
    expect(i18n.t("map")).toBe("Geo Command Map");
    await i18n.changeLanguage("fr");
    expect(i18n.t("map")).toBe("Geo Command Map");
  });
  it("resolves every dynamic demo status and feature key in both languages without fallback", async () => {
    const featureKinds = {
      area: true, linear: true, segment: true, facility: true, barrier: true, consequence: true,
    } satisfies Record<NonNullable<MapFeatureProperties["featureKind"]>, boolean>;
    const bowtieStories = ["bowtieStoryA", "bowtieStoryC", "bowtieStoryD"] as const;
    const barrierTypes = { technical: true, organisational: true, human: true } satisfies Record<BarrierType, boolean>;
    const barrierSides = { preventive: true, mitigative: true } satisfies Record<BowtieView["barriers"][number]["side"], boolean>;
    const triadDimensions = { effective: true, independent: true, auditable: true } satisfies Record<TriadDimension, boolean>;
    const barrierHealth = { healthy: true, degraded: true, failed: true, unverified: true } satisfies Record<RiskBarrier["health"], boolean>;
    const riskZones = { red: true, amber: true, green: true } satisfies Record<RiskZone, boolean>;
    const severityDimensions = {
      people: true, environment: true, financial: true, serviceContinuity: true, reputation: true, legalRegulatory: true,
    } satisfies Record<keyof RiskSeverity, boolean>;
    const keys = [
      ...["ready", "playing", "paused", "finished"].map((value) => `simulationState.${value}`),
      ...Object.keys(featureKinds).map((value) => `featureKinds.${value}`),
      ...["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED"].map((value) => `classifications.${value}`),
      ...Object.keys(barrierTypes).map((value) => `barrierType.${value}`),
      ...Object.keys(barrierTypes),
      ...Object.keys(barrierSides),
      ...Object.keys(triadDimensions),
      ...Object.keys(barrierHealth).map((value) => `barrierHealth.${value}`),
      ...Object.keys(riskZones).map((value) => `riskZone.${value}`),
      ...Object.keys(severityDimensions).map((value) => `severityDimension.${value}`),
      ...["healthy", "degraded", "failed", "unverified"],
      ...["healthy", "degraded", "failed", "unverified"].map((value) => `healthProposalHealth.${value}`),
      ...bowtieStories,
      "intolerable", "alarp", "acceptable", "assets", "barriers", "consequences", "viewer", "operator", "manager",
      "viewerDetail", "operatorDetail", "managerDetail",
    ];
    for (const language of ["en", "th"]) {
      await i18n.changeLanguage(language);
      for (const key of keys) {
        expect(i18n.getResource(language, "translation", key), `${language}: ${key}`).toBeTypeOf("string");
        expect(i18n.t(key)).not.toBe(key);
      }
    }
  });
  it("uses English when a Thai key is missing", async () => {
    const instance = createInstance();
    await instance.init({ lng: "th", fallbackLng: "en", resources: {
      en: { translation: { map: "Geo Command Map" } }, th: { translation: {} },
    } });
    expect(instance.t("map")).toBe("Geo Command Map");
  });
  it("interpolates Thai counts and Barrier identifiers without changing the identifier", async () => {
    await i18n.changeLanguage("th");
    expect(i18n.t("healthProposalCount", { count: 2 })).toBe("ข้อเสนอ Health 2 รายการ");
    expect(i18n.t("healthProposalAcceptFor", { barrier: "SYNTHETIC-CP-01" })).toBe("ยอมรับข้อเสนอ Health สำหรับ SYNTHETIC-CP-01");
  });
});
