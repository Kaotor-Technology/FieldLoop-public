import { create } from "zustand";

export const usePreferences = create<{
  language: "en" | "th";
  nightShift: boolean;
  toggleLanguage: () => void;
  toggleNightShift: () => void;
}>((set) => ({
  language: "en",
  nightShift: window.matchMedia("(prefers-color-scheme: dark)").matches,
  toggleLanguage: () => set((state) => ({ language: state.language === "en" ? "th" : "en" })),
  toggleNightShift: () => set((state) => ({ nightShift: !state.nightShift })),
}));
