import { PubSub } from "@google-cloud/pubsub";
import type { MessageTransport } from "./signal-publisher.js";

/** Uses ADC (Cloud Run identity or the emulator); never creates topics or credentials. */
export class GooglePubSubTransport implements MessageTransport {
  constructor(private readonly client: PubSub) {}

  publish(topic: string, data: Uint8Array, attributes: Record<string, string>): Promise<string> {
    return this.client.topic(topic).publishMessage({ data: Buffer.from(data), attributes });
  }
}

export function createGooglePubSubTransport(projectId: string): { transport: MessageTransport; close: () => Promise<void> } {
  const client = new PubSub({ projectId });
  return { transport: new GooglePubSubTransport(client), close: () => client.close() };
}
