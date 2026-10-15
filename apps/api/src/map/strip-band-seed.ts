import { readFileSync } from "node:fs";
import type { components } from "@fieldloop/contracts";

export type AssetStripBand = components["schemas"]["AssetStripBand"];

/** Loaded only by web-api; the classified seed is never served as a static SPA asset. */
export const DL01_STATIC_STRIP_BAND = JSON.parse(
  readFileSync(new URL("../../../../data/synthetic/dl-01/strip-band.json", import.meta.url), "utf8"),
) as AssetStripBand;
