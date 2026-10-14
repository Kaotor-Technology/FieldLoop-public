import { describe, expect, it } from "vitest";
import { translationKeys, validateResources } from "./check-i18n.mjs";

describe("translation CI gate", () => {
  it("reports missing nested keys in either language and keys absent from both", () => {
    expect(validateResources({ en: { health: { failed: "Failed" } }, th: { extra: "เพิ่มเติม" } }, ["unknownUIKey"])).toEqual([
      "en: missing key extra", "th: missing key health.failed", "en: missing key unknownUIKey", "th: missing key unknownUIKey",
    ]);
  });
  it("rejects empty values and changed interpolation placeholders", () => {
    expect(validateResources({ en: { count: "Count: {{count}}", empty: "" }, th: { count: "จำนวน {{total}}", empty: " " } })).toEqual([
      "th: interpolation mismatch for count", "en: empty or invalid value for empty", "th: empty or invalid value for empty",
    ]);
  });
  it("accepts nested resources with reordered placeholders", () => {
    expect(validateResources({ en: { label: { value: "{{name}}: {{count}}" } }, th: { label: { value: "{{count}}: {{name}}" } } })).toEqual([]);
  });
  it("extracts literal and conditional UI calls without confusing comments or unrelated strings", () => {
    expect(translationKeys('// t("comment")\nconst x = "not-a-key"; t("map"); i18next.t("heading"); translator.t(pending ? "loading" : "retry"); t(`skip`);')).toEqual(["map", "heading", "loading", "retry", "skip"]);
  });
  it("reports missing keys from i18next member calls", () => {
    const keys = translationKeys('i18next.t("missingStaticKey")');
    expect(validateResources({ en: {}, th: {} }, keys)).toEqual([
      "en: missing key missingStaticKey", "th: missing key missingStaticKey",
    ]);
  });
});
