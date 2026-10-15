import type { Signal, WorkerEvent } from "@fieldloop/contracts";
import type { ServiceIdentityVerifier } from "@fieldloop/adapters";

export class WorkerError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export interface WorkerStore {
  ingest(signal: Signal): Promise<void>;
  detectSilence(now: Date): Promise<number>;
  ageEvidence(now: Date): Promise<{ changed: number; notified: number }>;
  publishPending(publish: (event: WorkerEvent) => Promise<void>): Promise<void>;
}
export interface WorkerRuntime {
  expireActions?: () => Promise<number>;
  store: WorkerStore;
  identity: ServiceIdentityVerifier;
  audience: string;
  pushEmail: string;
  schedulerEmail: string;
  subscription: string;
  orgId: string;
  environment: string;
  simulatedOnly: boolean;
  publish: (event: WorkerEvent) => Promise<void>;
  close: () => Promise<void>;
}
