/** Server-authorized snapshot only. This type is not an access-control decision.
 * Do not bundle a classified seed or fetch it through public static assets. */
export interface StripBandData {
  readonly schemaVersion: 1;
  readonly assetCode: string;
  readonly lengthM: number;
  readonly classification: "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "HIGHLY_RESTRICTED";
  readonly simulated: true;
  readonly label: "SYNTHETIC";
  readonly segments: readonly {
    readonly id: string; readonly name: string;
    readonly chainageFromM: number; readonly chainageToM: number;
  }[];
  readonly facilities: readonly { readonly id: string; readonly name: string; readonly chainageM: number }[];
  readonly barriers: readonly {
    readonly id: string; readonly name: string;
    readonly health: "healthy" | "degraded" | "failed" | "unverified";
    readonly chainageM: null;
  }[];
  readonly inspections: readonly never[];
  readonly threatCategories: readonly never[];
}
