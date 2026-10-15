import { expect, it } from "vitest";
import { isLowConfidence, LOW_CONFIDENCE_THRESHOLD } from "./geo-references";

it("flags only references below the low-confidence threshold", () => {
  expect(isLowConfidence({ confidence: LOW_CONFIDENCE_THRESHOLD - 0.01 })).toBe(true);
  expect(isLowConfidence({ confidence: LOW_CONFIDENCE_THRESHOLD })).toBe(false);
  expect(isLowConfidence({ confidence: 0.85 })).toBe(false);
});
