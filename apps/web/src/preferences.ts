import { create } from "zustand";

export const usePreferences = create<{
  language: "en" | "th";
  languagePreferenceKey: string | null;
  nightShift: boolean;
  loadUserLanguage: (orgId: string, subject: string) => void;
  toggleLanguage: () => void;
  toggleNightShift: () => void;
}>((set) => ({
  language: "en",
  languagePreferenceKey: null,
  nightShift: window.matchMedia("(prefers-color-scheme: dark)").matches,
  loadUserLanguage: (orgId, subject) => {
    const languagePreferenceKey = `fieldloop.language:${JSON.stringify([orgId, subject])}`;
    let language: "en" | "th" = "en";
    try {
      if (window.localStorage.getItem(languagePreferenceKey) === "th") language = "th";
    } catch (error) {
      console.warn("Language preference storage is unavailable; using English.", error);
    }
    set({ language, languagePreferenceKey });
  },
  toggleLanguage: () => set((state) => {
    const language = state.language === "en" ? "th" : "en";
    if (state.languagePreferenceKey) {
      try {
        window.localStorage.setItem(state.languagePreferenceKey, language);
      } catch (error) {
        console.warn("Language preference could not be saved; it remains active for this session.", error);
      }
    }
    return { language };
  }),
  toggleNightShift: () => set((state) => ({ nightShift: !state.nightShift })),
}));
