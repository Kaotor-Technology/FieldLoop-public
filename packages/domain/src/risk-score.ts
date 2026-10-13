import type { RiskMatrix, RiskZone } from "@fieldloop/contracts";

// PRD §6.1 demo calibration. Production inputs must use an Organisation-owned matrix.
export const DEMO_RISK_MATRIX: RiskMatrix = {
  frequencyThresholds: [1e-5, 1e-4, 1e-3, 1e-2],
  cells: [
    ["green", "green", "green", "green", "amber"],
    ["green", "green", "amber", "amber", "amber"],
    ["green", "amber", "amber", "amber", "red"],
    ["green", "amber", "amber", "amber", "red"],
    ["amber", "amber", "amber", "red", "red"],
  ].map((row, frequencyIndex) => row.map((zone, severityIndex) => ({
    zone: zone as RiskZone,
    rank: frequencyIndex * 5 + severityIndex + 1,
  }))),
};
