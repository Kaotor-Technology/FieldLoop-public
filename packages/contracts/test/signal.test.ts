import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isSignal } from "../src/signal.js";

export const signalCases: { name: string; valid: boolean; signal: unknown }[] = JSON.parse(
  readFileSync(new URL("./fixtures/signal-cases.json", import.meta.url), "utf8"),
);

describe("signal.v1 shared wire cases (FL-148 / SIM-3)", () => {
  it.each(signalCases)("$name", ({ signal, valid }) => {
    const before = JSON.stringify(signal);
    expect(isSignal(signal)).toBe(valid);
    expect(JSON.stringify(signal)).toBe(before);
  });
});
