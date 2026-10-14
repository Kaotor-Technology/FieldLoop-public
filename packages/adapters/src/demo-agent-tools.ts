// Definition vocabulary from architecture §7.3. Execution and Guardrail checks belong
// to the assistant runtime; accepting a name here does not grant execution permission.
export const DEMO_AGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "search_knowledge", "get_document", "get_asset", "get_barriers", "get_bowtie_risk",
  "get_action_requests", "get_stakeholders", "spatial_query", "get_scenario_state",
  "extract_geo_references", "create_draft", "create_action_request",
]);
