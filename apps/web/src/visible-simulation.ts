export interface BannerQueryData {
  active: boolean;
  data: unknown;
  includeInBanner?: boolean;
}

function containsSimulatedRecord(value: unknown, seen: Set<object>): boolean {
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsSimulatedRecord(item, seen));

  const record = value as Record<string, unknown>;
  return record["simulated"] === true || Object.values(record).some((item) => containsSimulatedRecord(item, seen));
}

export function hasVisibleSimulatedData(queries: readonly BannerQueryData[]): boolean {
  return queries.some(({ active, data, includeInBanner = true }) =>
    active && includeInBanner && containsSimulatedRecord(data, new Set()),
  );
}
