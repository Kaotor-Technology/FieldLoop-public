import { Ajv2020 } from "ajv/dist/2020.js";
import { default as formats } from "ajv-formats";
import { signalSchema, type Signal } from "./generated/signal.js";

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
formats.default(ajv);
const validate = ajv.compile<Signal>(signalSchema);

/** Validate without coercing, defaulting or stripping fields. */
export function isSignal(value: unknown): value is Signal {
  return validate(value);
}

export { signalSchema, type Signal };
