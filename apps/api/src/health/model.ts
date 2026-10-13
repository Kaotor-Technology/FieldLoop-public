import type { CurrentUser } from "../auth/service.js";
import type { WorkerEvent } from "@fieldloop/contracts";

export type HealthDecision = "accept" | "reject";
export interface HealthDecisionResult {
  healthProposalId: string;
  status: "accepted" | "rejected";
  barrierId: string;
  health: string;
}
export interface NotificationItem {
  id: string;
  subjectType: "action_request" | "health_change" | "evidence";
  subjectId: string;
  barrierId: string | null;
  channel: string;
  status: string;
  createdAt: string;
  simulated: boolean;
  classification: string;
}
export interface NotificationPage {
  items: NotificationItem[];
  limit: number;
  nextCursor: string | null;
}
export interface EventPosition {
  createdAt: string;
  id: string;
}
export interface StoredHealthEvent {
  position: EventPosition;
  event: WorkerEvent;
}

export interface HealthServicePort {
  decide(input: {
    user: CurrentUser;
    proposalId: string;
    decision: HealthDecision;
    reason: string;
    idempotencyKey: string;
  }): Promise<HealthDecisionResult>;
  listNotifications(user: CurrentUser, cursor: string | undefined, limit: number): Promise<NotificationPage>;
  latestEventPosition(): Promise<EventPosition | null>;
  listEvents(user: CurrentUser, after: EventPosition | null, limit: number): Promise<StoredHealthEvent[]>;
}

export class HealthServiceError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 503, readonly code: string) {
    super(code);
    this.name = "HealthServiceError";
  }
}
