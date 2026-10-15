import createClient from "openapi-fetch";
import type { components, paths } from "@fieldloop/contracts";

const client = createClient<paths>({ baseUrl: "/api", credentials: "same-origin" });

export type GeoReference = components["schemas"]["GeoReference"];
export type GeoReferencePage = components["schemas"]["GeoReferencePage"];
export const LOW_CONFIDENCE_THRESHOLD = 0.5;
export const isLowConfidence = (reference: Pick<GeoReference, "confidence">): boolean =>
  reference.confidence < LOW_CONFIDENCE_THRESHOLD;
export const geoReferenceDraftsQueryKey = ["geo-references", "drafts"] as const;

export async function getGeoReferenceDrafts(signal: AbortSignal): Promise<GeoReferencePage> {
  const { data, error } = await client.GET("/v1/geo-references", {
    params: { query: { status: "draft", limit: 100 } }, signal,
  });
  if (error || !data) throw new Error("Geo Reference drafts are unavailable");
  return data;
}

export async function decideGeoReference(input: {
  geoReferenceId: string;
  decision: "confirm" | "reject";
  targetAssetId?: string;
  csrfToken: string;
}): Promise<GeoReference> {
  const headers = { "X-CSRF-Token": input.csrfToken, "Idempotency-Key": crypto.randomUUID() };
  if (input.decision === "confirm") {
    const { data, error } = await client.POST("/v1/geo-references/{geoReferenceId}:confirm", {
      params: { path: { geoReferenceId: input.geoReferenceId }, header: headers },
      ...(input.targetAssetId ? { body: { targetAssetId: input.targetAssetId } } : {}),
    });
    if (error || !data) throw new Error("Geo Reference could not be confirmed");
    return data;
  }
  const { data, error } = await client.POST("/v1/geo-references/{geoReferenceId}:reject", {
    params: { path: { geoReferenceId: input.geoReferenceId }, header: headers },
  });
  if (error || !data) throw new Error("Geo Reference could not be rejected");
  return data;
}
