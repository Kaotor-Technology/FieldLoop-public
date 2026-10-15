import type { components } from "@fieldloop/contracts";

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

/** Server-authorized snapshot only. This type is not an access-control decision. */
export type StripBandData = DeepReadonly<components["schemas"]["AssetStripBand"]>;
