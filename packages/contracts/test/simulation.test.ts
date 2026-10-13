import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { isRunCreate, isPlayerCommand } from "../src/simulation.js";

it("embeds exactly the canonical player schemas in the self-contained OpenAPI contract", async () => {
  const api = parse(await readFile(new URL("../openapi.yaml", import.meta.url), "utf8"));
  const wire = JSON.parse(await readFile(new URL("../simulation.v1.schema.json", import.meta.url), "utf8"));
  for (const [name, schema] of Object.entries(wire.$defs)) expect(api.components.schemas[name]).toEqual(schema);
});
it("rejects coercion, non-simulation controls and invented fields at the BFF boundary", () => {
  expect(isRunCreate({ scenarioId: "player-test", seed: 42, speed: 1 })).toBe(true);
  for (const body of [{ scenarioId: "player-test\n", seed: 42, speed: 1 }, { scenarioId: "player-test", seed: true, speed: 1 }, { scenarioId: "player-test", seed: 42, speed: "1" }, { scenarioId: "player-test", seed: 42, speed: 1, simulated: false }]) expect(isRunCreate(body)).toBe(false);
  expect(isPlayerCommand({ clock: "2026-10-13T00:00:00Z" })).toBe(false);
});
