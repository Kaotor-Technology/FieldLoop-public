import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import th from "./locales/th.json";

void i18next.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  supportedLngs: ["en", "th"],
  initAsync: false,
  interpolation: { escapeValue: false },
  resources: { en: { translation: en }, th: { translation: th } },
});

export default i18next;
