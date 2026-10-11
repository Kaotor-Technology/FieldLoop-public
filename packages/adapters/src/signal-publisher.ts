import { isSignal } from "@fieldloop/contracts";

export interface MessageTransport {
  publish(topic: string, data: Uint8Array, attributes: Record<string, string>): Promise<string>;
}

export interface SignalPublisherConfig {
  environment: "dev" | "demo" | "local";
  orgId: string;
  simulationOnly: boolean;
  signalTopic?: string;
  deadLetterTopic?: string;
}

export interface SignalPublishResult {
  outcome: "published" | "dead_lettered";
  messageId: string;
}

export const MAX_SIGNAL_BYTES = 256 * 1024;

/** Refuse lossy JSON conversions (NaN, undefined, Date, getters and cycles). */
function assertJson(value: unknown, depth = 0): void {
  if (depth > 64) throw new TypeError("Signal JSON exceeds the nesting limit");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || value === null) throw new TypeError("Signal must be JSON data");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError("Signal must contain only plain JSON objects");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError("Signal must use string keys");
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === "length") continue;
    if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)) throw new TypeError("Signal arrays cannot have named properties");
    if (!descriptor.enumerable || descriptor.get || descriptor.set) throw new TypeError("Signal must contain data properties");
    assertJson(descriptor.value, depth + 1);
  }
  // Sparse arrays serialize as null entries; reject them rather than changing observations.
  if (Array.isArray(value) && Object.keys(value).length !== value.length) throw new TypeError("Signal must use dense arrays");
}

export class SignalPublisher {
  private readonly config: Required<SignalPublisherConfig>;

  constructor(private readonly transport: MessageTransport, config: SignalPublisherConfig) {
    this.config = { signalTopic: "signals", deadLetterTopic: "fieldloop-v2-dead-letter", ...config };
    if (!["dev", "demo", "local"].includes(config.environment)
      || typeof config.orgId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(config.orgId) || config.orgId.includes("\n")
      || typeof config.simulationOnly !== "boolean"
      || !this.config.signalTopic.trim() || !this.config.deadLetterTopic.trim()
      || this.config.signalTopic === this.config.deadLetterTopic) {
      throw new TypeError("Invalid Signal publisher configuration");
    }
  }

  async publish(input: unknown): Promise<SignalPublishResult> {
    assertJson(input);
    const data = Buffer.from(JSON.stringify(input), "utf8");
    if (data.length > MAX_SIGNAL_BYTES) throw new RangeError("Signal exceeds 256 KiB");
    // Validate the exact serialized snapshot that will be sent, before any async work.
    const signal: unknown = JSON.parse(data.toString("utf8"));
    let failureReason: string | undefined;
    const validSignal = isSignal(signal) ? signal : undefined;
    if (!validSignal) failureReason = "validation_failed";
    else if (validSignal.orgId !== this.config.orgId) failureReason = "org_mismatch";
    else if (this.config.simulationOnly && !validSignal.simulated) failureReason = "simulation_required";

    const attributes: Record<string, string> = {
      environment: this.config.environment, orgId: this.config.orgId, schemaVersion: "signal.v1",
    };
    if (failureReason) {
      // Provenance on malformed input is untrusted. Quarantine at the highest class.
      attributes.failureReason = failureReason;
      attributes.classification = "HIGHLY_RESTRICTED";
    } else if (validSignal) {
      attributes.signalId = validSignal.id;
      attributes.simulated = String(validSignal.simulated);
      attributes.classification = validSignal.classification;
    }
    const messageId = await this.transport.publish(
      failureReason ? this.config.deadLetterTopic : this.config.signalTopic, data, attributes,
    );
    return { outcome: failureReason ? "dead_lettered" : "published", messageId };
  }
}
