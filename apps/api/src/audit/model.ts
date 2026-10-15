import type { CurrentUser } from "../auth/service.js";

export type AuditClassification = "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "HIGHLY_RESTRICTED";

export interface AuditEventItem {
  id: string;
  entityType: string;
  entity: string;
  action: string;
  actor: string;
  reason?: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  prevHash: string | null;
  hash: string;
  createdAt: string;
  simulated: boolean;
  classification: AuditClassification;
}

export interface AuditEventPage {
  items: AuditEventItem[];
  limit: number;
  nextCursor: string | null;
}

export interface AuditEventFilter {
  entityType?: string;
  entityId?: string;
}

export interface AuditServicePort {
  listEvents(user: CurrentUser, filter: AuditEventFilter, cursor: string | undefined, limit: number): Promise<AuditEventPage>;
}

export class AuditServiceError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 503, readonly code: string) {
    super(code);
    this.name = "AuditServiceError";
  }
}
