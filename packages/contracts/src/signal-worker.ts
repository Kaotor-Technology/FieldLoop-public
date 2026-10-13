import { Ajv2020 } from "ajv/dist/2020.js";
import { default as formats } from "ajv-formats";
import { schema as ruleSchema, type RegisteredSignalRule } from "./generated/registered-signal-rule.js";
import { schema as eventSchema, type WorkerEvent } from "./generated/worker-event.js";
import { pushSchema } from "./generated/push-schema.js";
import type { components } from "./generated/worker-api.js";

export type PubSubPush = components["schemas"]["PubSubPush"];

const ajv = new Ajv2020({ strict: true });
formats.default(ajv);
const validateRule = ajv.compile<RegisteredSignalRule>(ruleSchema);
const validateEvent = ajv.compile<WorkerEvent>(eventSchema);
const validatePush = ajv.compile<PubSubPush>(pushSchema);
export function isPubSubPush(value: unknown): value is PubSubPush { return validatePush(value); }
export function parseRegisteredSignalRule(value: unknown): RegisteredSignalRule {
  if (!validateRule(value) || value.pack !== value.targetBarrierSelector.pack) {
    throw new Error("Invalid registered Signal rule");
  }
  return value;
}
export function isWorkerEvent(value: unknown): value is WorkerEvent { return validateEvent(value); }
export type { RegisteredSignalRule, WorkerEvent };
