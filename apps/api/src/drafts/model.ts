import type { components } from "@fieldloop/contracts";
import type { CurrentUser } from "../auth/service.js";

export type DraftStatus = "needs_approval" | "approved" | "rejected";
export type DraftItem = components["schemas"]["Draft"];

export interface DraftServicePort {
  list(user: CurrentUser, status: DraftStatus, limit: number): Promise<DraftItem[]>;
  get(user: CurrentUser, draftId: string): Promise<DraftItem>;
  decide(input: {
    user: CurrentUser;
    draftId: string;
    decision: "approve" | "reject";
    reason?: string;
    idempotencyKey: string;
  }): Promise<DraftItem>;
}

export class DraftServiceError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 503, readonly code: string) {
    super(code);
    this.name = "DraftServiceError";
  }
}
