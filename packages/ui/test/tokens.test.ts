import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("DESIGN.md token export", () => {
  it("preserves every elevation, motion and typography token", () => {
    execFileSync("node", ["scripts/export-tokens.mjs"]);
    const source = readFileSync("../../DESIGN.md", "utf8").split("---")[1];
    const tokens = parse(source ?? "") as { elevation: Record<string, string>; motion: { "duration-ms": Record<string, number> }; typography: Record<string, { fontFamily: string }> };
    const css = readFileSync("dist/tokens.css", "utf8");
    for (const [name, value] of Object.entries(tokens.elevation)) expect(css).toContain(`--elevation-${name}: ${value};`);
    for (const [name, value] of Object.entries(tokens.motion["duration-ms"])) expect(css).toContain(`--motion-${name}: ${value}ms;`);
    for (const [name, value] of Object.entries(tokens.typography)) expect(css).toContain(`--type-${name}-font-family: ${JSON.stringify(value.fontFamily)};`);
    expect(readFileSync("dist/theme.css", "utf8")).toContain("@theme");
  });
});
