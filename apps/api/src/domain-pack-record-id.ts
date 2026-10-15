import { createHash } from "node:crypto";

export function domainPackRecordId(orgId: string, pack: string, kind: string, code: string): string {
  const hex = createHash("sha256").update(JSON.stringify(["fieldloop:domain-pack", orgId, pack, kind, code])).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}
