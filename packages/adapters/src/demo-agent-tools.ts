// Definition vocabulary from architecture §7.3. Execution and Guardrail checks belong
// to the assistant runtime; accepting a name here does not grant execution permission.
export const DEMO_AGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "search_knowledge", "get_document", "get_asset", "get_barriers", "get_bowtie_risk",
  "get_action_requests", "get_stakeholders", "spatial_query", "get_scenario_state",
  "extract_geo_references", "create_draft", "create_action_request", "prepare_public_warning",
]);

// Registry inputs also admit this proposal-only legacy operation. It is not an executable
// assistant tool and is intentionally absent from the agent definition vocabulary above.
export const DEMO_REGISTERED_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...DEMO_AGENT_TOOL_NAMES, "cmms.create_work_order",
]);
