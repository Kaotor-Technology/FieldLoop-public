import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { components } from "./generated/api.js";
import { simulationSchema } from "./generated/simulation-schema.js";

const validator = new Ajv2020({ strict: true, allErrors: true, coerceTypes: false, allowUnionTypes: true });
addFormats.default(validator);
export const isSimulationRun = validator.compile<components["schemas"]["SimulationRun"]>(simulationSchema.$defs.SimulationRun);
export const isScenarioSummary = validator.compile<components["schemas"]["ScenarioSummary"]>(simulationSchema.$defs.ScenarioSummary);
export const isRunCreate = validator.compile<components["schemas"]["RunCreate"]>(simulationSchema.$defs.RunCreate);
export const isPlayerCommand = validator.compile<components["schemas"]["PlayerCommand"]>(simulationSchema.$defs.PlayerCommand);
