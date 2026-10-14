import { Ajv2020 } from "ajv/dist/2020.js";
import { agentDefinitionSchema, type AgentDefinition } from "./generated/agent-definition.js";
import { domainPackSchema, type DomainPack } from "./generated/domain-pack.js";

import { genAiSafetySchema, type GenAiSafetyPack } from "./generated/gen-ai-safety.js";

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validatePack = ajv.compile<DomainPack>(domainPackSchema);
const validateAiSafety = ajv.compile<GenAiSafetyPack>(genAiSafetySchema);
const validateAgent = ajv.compile<AgentDefinition>(agentDefinitionSchema);

export function parseDomainPack(value: unknown, file: string): DomainPack {
  if (!validatePack(value)) throw new Error(`${file}: ${ajv.errorsText(validatePack.errors)}`);
  return value;
}

export function parseAgentDefinition(value: unknown, file: string): AgentDefinition {
  if (!validateAgent(value)) throw new Error(`${file}: ${ajv.errorsText(validateAgent.errors)}`);
  return value;
}

export function parseGenAiSafetyPack(value: unknown, file: string): GenAiSafetyPack {
  if (!validateAiSafety(value)) throw new Error(`${file}: ${ajv.errorsText(validateAiSafety.errors)}`);
  return value;
}

export { genAiSafetySchema, type GenAiSafetyPack, domainPackSchema, agentDefinitionSchema, type DomainPack, type AgentDefinition };
