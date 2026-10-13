import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { calculateRisk } from "../dist/risk/index.js";

const seed = JSON.parse(await readFile(new URL("../../../data/synthetic/dl-01/bowtie-a.json", import.meta.url), "utf8"));
// Deliberately synthetic test calibration, not an approved Organisation matrix.
const matrix = {
  frequencyThresholds: [1e-5, 1e-4, 1e-3, 1e-2],
  cells: Array.from({ length: 5 }, (_, row) => Array.from({ length: 5 }, (_, column) => ({ rank: (row + 1) * (column + 1), zone: "green" }))),
};
const input = {
  bowtieId: seed.id, matrix,
  barriers: seed.barriers.map(({ id, type, side, pfdBand, health, independenceGroupId }) => ({
    id, type, side, pfdBand, health, ...(independenceGroupId === undefined ? {} : { independenceGroupId }),
  })),
  threats: seed.threats.map(({ id, frequencyPerYear }) => ({ id, frequencyPerYear })),
  consequences: seed.consequences.map(({ id, conditionalProbability, severity }) => ({
    id, conditionalProbability,
    severity: Object.fromEntries(Object.entries(severity).map(([key, value]) => [key === "service_continuity" ? "serviceContinuity" : key, value])),
  })),
  independenceGroups: seed.independenceGroups.map(({ id }) => ({ id })),
  paths: seed.paths,
};
for (let count = 0; count < 100; count++) calculateRisk(input);
const samples = [];
for (let count = 0; count < 1000; count++) {
  const started = performance.now();
  calculateRisk(input);
  samples.push(performance.now() - started);
}
samples.sort((a, b) => a - b);
console.log(JSON.stringify({ bowtie: seed.id, samples: samples.length, unit: "ms", p50: samples[499], p95: samples[949], max: samples.at(-1) }));
