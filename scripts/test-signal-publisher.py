"""Exercise both real SDK adapters against a loopback Pub/Sub emulator only."""

import asyncio
import json
import os
import socket
import subprocess
import time
from pathlib import Path
from uuid import uuid4

from fieldloop_common.google_pubsub import GooglePubSubTransport
from fieldloop_common.signal import is_signal
from fieldloop_common.signal_publisher import SignalPublisher
from google.cloud.pubsub_v1 import PublisherClient, SubscriberClient

root = Path(__file__).resolve().parents[1]
host = os.environ.get("PUBSUB_EMULATOR_HOST", "")
if not host.startswith(("127.0.0.1:", "localhost:")):
    raise SystemExit("Set PUBSUB_EMULATOR_HOST to a loopback emulator; real GCP is forbidden here")
address, port = host.rsplit(":", 1)
for attempt in range(120):
    try:
        with socket.create_connection((address, int(port)), timeout=0.5):
            break
    except OSError:
        if attempt == 119:
            raise
        time.sleep(0.25)

project = "fieldloop-contract-test"
suffix = uuid4().hex
topic_names = [f"signals-{suffix}", f"dead-letter-{suffix}"]
client = PublisherClient()
subscriber = SubscriberClient()
topics: list[str] = []
subscriptions: list[str] = []
cases = json.loads((root / "packages/contracts/test/fixtures/signal-cases.json").read_text())
signal = cases[0]["signal"]

try:
    for name in topic_names:
        topic = client.topic_path(project, name)
        client.create_topic(request={"name": topic}, timeout=10)
        topics.append(topic)
        subscription = subscriber.subscription_path(project, f"review-{name}")
        subscriber.create_subscription(request={"name": subscription, "topic": topic}, timeout=10)
        subscriptions.append(subscription)

    publisher = SignalPublisher(
        GooglePubSubTransport(client, project_id=project),
        environment="dev",
        org_id="fieldloop-demo",
        simulation_only=True,
        signal_topic=topic_names[0],
        dead_letter_topic=topic_names[1],
    )
    assert asyncio.run(publisher.publish(signal)).outcome == "published"
    assert asyncio.run(publisher.publish({"schemaVersion": "signal.v1"})).outcome == "dead_lettered"

    # Execute Node in the adapters package so dependency resolution matches its runtime.
    subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            """
import { PubSub } from '@google-cloud/pubsub';
import { GooglePubSubTransport, SignalPublisher } from './dist/index.js';
const client = new PubSub({ projectId: 'fieldloop-contract-test' });
try {
  const publisher = new SignalPublisher(new GooglePubSubTransport(client), {
    environment: 'dev', orgId: 'fieldloop-demo', simulationOnly: true,
    signalTopic: process.env.FL_TEST_SIGNAL_TOPIC, deadLetterTopic: process.env.FL_TEST_DEAD_TOPIC,
  });
  const valid = await publisher.publish(JSON.parse(process.env.FL_TEST_SIGNAL));
  const invalid = await publisher.publish({ schemaVersion: 'signal.v1' });
  if (valid.outcome !== 'published' || invalid.outcome !== 'dead_lettered') {
    throw new Error('Wrong routing');
  }
} finally { await client.close(); }
""",
        ],
        cwd=root / "packages/adapters",
        check=True,
        timeout=45,
        env={
            **os.environ,
            "FL_TEST_SIGNAL": json.dumps(signal),
            "FL_TEST_SIGNAL_TOPIC": topic_names[0],
            "FL_TEST_DEAD_TOPIC": topic_names[1],
        },
    )
    for index, subscription in enumerate(subscriptions):
        messages = []
        # Pull may return fewer messages than requested; collect until both SDK sends arrive.
        for _ in range(4):
            response = subscriber.pull(
                request={"subscription": subscription, "max_messages": 2 - len(messages)},
                timeout=10,
            )
            messages.extend(response.received_messages)
            if len(messages) == 2:
                break
        assert len(messages) == 2, "Expected one message per SDK on each topic"
        for received in messages:
            message = received.message
            body = json.loads(message.data)
            assert message.attributes["environment"] == "dev"
            assert message.attributes["orgId"] == "fieldloop-demo"
            if index == 0:
                assert is_signal(body) and body == signal
                assert message.attributes["simulated"] == "true"
                assert message.attributes["signalId"] == signal["id"]
            else:
                assert body == {"schemaVersion": "signal.v1"}
                assert message.attributes["failureReason"] == "validation_failed"
                assert message.attributes["classification"] == "HIGHLY_RESTRICTED"
        subscriber.acknowledge(
            request={"subscription": subscription, "ack_ids": [item.ack_id for item in messages]},
            timeout=10,
        )
    print("Pub/Sub emulator: TS + Python valid delivery and invalid quarantine passed")
finally:
    for subscription in subscriptions:
        subscriber.delete_subscription(request={"subscription": subscription}, timeout=10)
    for topic in topics:
        client.delete_topic(request={"topic": topic}, timeout=10)
    client.stop()
    subscriber.close()
