export interface AgentContextChip {
  key: string;
  label: string;
  value: string;
  searchKeys: readonly string[];
}

type Translate = (key: string) => string;

const featureKindKeys: Record<string, string> = {
  area: "agentFeatureArea",
  facility: "agentFeatureFacility",
  linear: "agentFeatureLinear",
  segment: "agentFeatureSegment",
  barrier: "agentFeatureBarrier",
  consequence: "agentFeatureConsequence",
};

export function buildAgentContextChips(
  search: Record<string, unknown>,
  translate: Translate,
): AgentContextChip[] {
  const chips: AgentContextChip[] = [];
  const featureId = readSearchValue(search["agentFeatureId"]);
  const featureName = readSearchValue(search["agentFeatureName"]);
  const featureKind = readSearchValue(search["agentFeatureKind"]);
  if (featureId || featureName) {
    const kind = featureKindKeys[featureKind ?? ""] ? translate(featureKindKeys[featureKind ?? ""] ?? "agentFeature") : translate("agentFeature");
    const parts = [kind, featureName, featureId ? "ID " + featureId : undefined].filter((part): part is string => Boolean(part));
    chips.push({
      key: "feature",
      label: translate("agentContextFeature"),
      value: parts.join(" · "),
      searchKeys: ["agentFeatureId", "agentFeatureName", "agentFeatureKind"],
    });
  }

  const chainageFrom = readFiniteNumber(search["agentChainageFrom"]);
  const chainageTo = readFiniteNumber(search["agentChainageTo"]);
  if (chainageFrom !== undefined || chainageTo !== undefined) {
    const from = chainageFrom === undefined ? "?" : formatNumber(chainageFrom);
    const to = chainageTo === undefined ? from : formatNumber(chainageTo);
    chips.push({
      key: "chainage",
      label: translate("agentContextChainage"),
      value: "KP " + from + "–" + to,
      searchKeys: ["agentChainageFrom", "agentChainageTo"],
    });
  }

  const incidentId = readSearchValue(search["incidentId"]);
  if (incidentId) chips.push({
    key: "incident",
    label: translate("agentContextIncident"),
    value: incidentId,
    searchKeys: ["incidentId"],
  });

  const scenarioId = readSearchValue(search["scenarioId"]) ?? readSearchValue(search["scenario"]);
  if (scenarioId) chips.push({
    key: "scenario",
    label: translate("agentContextScenario"),
    value: scenarioId,
    searchKeys: ["scenarioId", "scenario"],
  });

  const bbox = readBoundingBox(search["bbox"]);
  if (bbox) chips.push({
    key: "map-area",
    label: translate("agentContextMapArea"),
    value: bbox,
    searchKeys: ["bbox"],
  });
  return chips;
}

export function removeAgentContextSearch(
  search: Record<string, unknown>,
  chip: AgentContextChip,
): Record<string, unknown> {
  const removed = new Set(chip.searchKeys);
  return Object.fromEntries(Object.entries(search).filter(([key]) => !removed.has(key)));
}

export function contextualizeAgentMessage(message: string, chips: readonly AgentContextChip[]): string {
  const question = message.trim();
  if (chips.length === 0) return question;
  const context = chips.map((chip) => "- " + chip.label + ": " + chip.value).join("\n");
  return "Current map context (user-selected metadata):\n" + context + "\n\nUser question:\n" + question;
}

function readSearchValue(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim().slice(0, 160);
  return text.length > 0 ? text : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (String(value).trim() === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function readBoundingBox(value: unknown): string | undefined {
  const raw = readSearchValue(value);
  if (!raw) return undefined;
  const coordinates = raw.split(",").map((coordinate) => Number(coordinate.trim()));
  if (coordinates.length !== 4 || coordinates.some((coordinate) => !Number.isFinite(coordinate))) return undefined;
  return coordinates.map((coordinate) => String(coordinate)).join(", ");
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 3 }).format(value);
}
