import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { actionSchema, type ActionRequestCreate, type ToolCallCheck } from "./generated/actions.js";
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats.default(ajv);
ajv.addSchema(actionSchema);
const create = ajv.compile<ActionRequestCreate>({ $ref: `${actionSchema.$id}#/$defs/ActionRequestCreate` });
const check = ajv.compile<ToolCallCheck>({ $ref: `${actionSchema.$id}#/$defs/ToolCallCheck` });
export function isActionRequestCreate(value: unknown): value is ActionRequestCreate { return create(value); }
export function isToolCallCheck(value: unknown): value is ToolCallCheck { return check(value); }
export { actionSchema };
export type { ActionLevel, ActionType, ActionTarget, ActionClassification, ActionRequestCreate, ActionRequest, ActionRequester, ToolCallCheck, ToolCallDecision } from "./generated/actions.js";
