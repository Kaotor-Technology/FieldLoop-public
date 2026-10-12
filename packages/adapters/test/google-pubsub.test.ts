import { PubSub } from "@google-cloud/pubsub";
import { afterEach, expect, it, vi } from "vitest";
import { GooglePubSubTransport } from "../src/google-pubsub.js";

afterEach(() => vi.restoreAllMocks());

it("sends bytes and routing attributes through the SDK and awaits acknowledgement", async () => {
  const client = new PubSub({ projectId: "fieldloop-contract-test" });
  const topic = client.topic("signals");
  vi.spyOn(client, "topic").mockReturnValue(topic);
  let acknowledge: (id: string) => void = () => { throw new Error("No acknowledgement waiter"); };
  const ack = new Promise<string>((resolve) => { acknowledge = resolve; });
  const publish = vi.spyOn(topic, "publishMessage").mockReturnValue(ack);
  const data = Buffer.from('{"label":"SIMULATION"}');
  const attributes = { environment: "dev", simulated: "true" };
  const transport = new GooglePubSubTransport(client);
  let complete = false;
  const pending = transport.publish("signals", data, attributes).then((id) => { complete = true; return id; });
  await Promise.resolve();
  expect(complete).toBe(false);
  expect(client.topic).toHaveBeenCalledWith("signals");
  expect(publish).toHaveBeenCalledWith({ data, attributes });
  acknowledge("sdk-message");
  await expect(pending).resolves.toBe("sdk-message");
  publish.mockRejectedValueOnce(new Error("permission denied"));
  await expect(transport.publish("signals", data, attributes)).rejects.toThrow("permission denied");
  await client.close();
});
