import { create } from "zustand";

export const useSimulationDraft = create<{
  scenarioId: string; seed: string; bookmarkId: string;
  selectScenario: (value: string) => void; setSeed: (value: string) => void;
  selectBookmark: (value: string) => void; resetTransient: () => void;
}>((set) => ({
  scenarioId: "", seed: "42", bookmarkId: "",
  selectScenario: (scenarioId) => set({ scenarioId }), setSeed: (seed) => set({ seed }),
  selectBookmark: (bookmarkId) => set({ bookmarkId }), resetTransient: () => set({ bookmarkId: "" }),
}));
