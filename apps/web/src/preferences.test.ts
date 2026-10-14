import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const values = new Map<string, string>();
vi.stubGlobal("window", {
  matchMedia: () => ({ matches: false }),
  localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  },
});
const { usePreferences } = await import("./preferences");

beforeEach(() => {
  values.clear();
  usePreferences.setState({ language: "en", languagePreferenceKey: null });
});
afterEach(() => { vi.restoreAllMocks(); });

describe("language preference per user", () => {
  it("defaults to English without writing browser storage and restores an explicit choice", () => {
    const store = usePreferences.getState();
    store.loadUserLanguage("synthetic-org", "synthetic-operator");
    expect(usePreferences.getState().language).toBe("en");
    expect(values.size).toBe(0);
    store.toggleLanguage();
    expect([...values.values()]).toEqual(["th"]);
    store.loadUserLanguage("synthetic-org", "synthetic-operator");
    expect(usePreferences.getState().language).toBe("th");
  });
  it("isolates users and Organisations and rejects an unsupported stored language", () => {
    const store = usePreferences.getState();
    store.loadUserLanguage("synthetic-org", "synthetic-operator");
    store.toggleLanguage();
    store.loadUserLanguage("synthetic-org", "synthetic-viewer");
    expect(usePreferences.getState().language).toBe("en");
    store.loadUserLanguage("other-synthetic-org", "synthetic-operator");
    expect(usePreferences.getState().language).toBe("en");
    values.set(usePreferences.getState().languagePreferenceKey ?? "", "fr");
    store.loadUserLanguage("other-synthetic-org", "synthetic-operator");
    expect(usePreferences.getState().language).toBe("en");
  });
  it("keeps the toggle usable when storage is blocked and reports the failure", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => { throw new Error("Storage blocked"); });
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("Storage blocked"); });
    const store = usePreferences.getState();
    store.loadUserLanguage("synthetic-org", "synthetic-operator");
    store.toggleLanguage();
    expect(usePreferences.getState().language).toBe("th");
    expect(warning).toHaveBeenCalledTimes(2);
  });
});
