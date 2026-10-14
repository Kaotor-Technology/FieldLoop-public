import { Ajv2020 } from "ajv/dist/2020.js";
import { riskSchema, type RiskInput, type RiskSnapshot, type RiskSeverity } from "./generated/risk.js";

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(riskSchema);
const validateInput = ajv.compile<RiskInput>({ $ref: `${riskSchema.$id}#/$defs/RiskInput` });
const validateSeverity = ajv.compile<RiskSeverity>({ $ref: `${riskSchema.$id}#/$defs/RiskSeverity` });
const validateSnapshot = ajv.compile<RiskSnapshot>({ $ref: `${riskSchema.$id}#/$defs/RiskSnapshot` });

/** Validate without coercing, defaulting or stripping fields. */
export function riskInputErrors(value: unknown): readonly { path: string; message: string }[] {
  if (validateInput(value)) return [];
  return (validateInput.errors ?? []).map(error => ({ path: error.instancePath, message: error.message ?? "Invalid risk input" }));
}

export function isRiskSeverity(value: unknown): value is RiskSeverity {
  return validateSeverity(value);
}

export function isRiskSnapshot(value: unknown): value is RiskSnapshot {
  return validateSnapshot(value);
}

export { riskSchema };
export type {
  RiskInput, RiskSnapshot, RiskBarrier, RiskPath, RiskMatrix, RiskCell,
  RiskPathResult, RiskThreatResult, RiskConsequenceResult, RiskSeverity,
  BarrierHealth, BarrierType, BarrierSide, RiskBand, RiskZone,
} from "./generated/risk.js";
