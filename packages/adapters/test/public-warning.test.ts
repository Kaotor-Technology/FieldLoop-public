import { expect, it } from "vitest";
import { publicWarningAction } from "../src/public-warning.js";
const input = { templateId: "district-z3-exercise-v1", channels: ["telegram", "discord"], recipientRefs: ["sandbox:district-z3"] };
it("builds only the authored Public source with provenance and no caller text", () => {
  const action = publicWarningAction(input);
  expect(action.classification).toBe("PUBLIC");
  expect(action.actionLevel).toBe("l2");
  expect(action.payload["message"]).toMatch(/^SIMULATION/);
  expect(action.payload["publicSource"]).toEqual(expect.objectContaining({ id: input.templateId, classification: "PUBLIC", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }));
  expect(action.citations).toEqual([`public-warning:${input.templateId}`]);
});
it("rejects free text, alternate templates, recipients, duplicates and unsafe channels", () => {
  for (const payload of [{ ...input, message: "CONFIDENTIAL detail" }, { ...input, advice: "secret" },
    { ...input, templateId: "unknown" }, { ...input, recipientRefs: ["sandbox:other"] },
    { ...input, channels: ["sms"] }, { ...input, channels: [] }, { ...input, channels: ["telegram", "telegram"] }]) {
    expect(() => publicWarningAction(payload)).toThrow("invalid_public_warning_selection");
  }
});
