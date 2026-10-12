"""Exercise the simulator's Signal emission on the real Pub/Sub SDK against a loopback emulator."""

import asyncio
import json
import uuid
from datetime import UTC, datetime

from emulator_support import require_loopback_emulator
from fieldloop_common.signal import is_signal
from fieldloop_simulator.mock_historian import SimulatedHistorian
from fieldloop_simulator.mock_patrol import SimulatedPatrol
from fieldloop_simulator.mock_signals import (
    SimulatedSignalEmitter,
    signal_publisher_from_environment,
)
from google.cloud.pubsub_v1 import PublisherClient, SubscriberClient

require_loopback_emulator()

# The composition uses the deployed topic names, so isolate the run by project instead.
project = f"fieldloop-sim-{uuid.uuid4().hex[:12]}"
signal_topic, dead_letter_topic = "signals", "fieldloop-v2-dead-letter"
admin = PublisherClient()
subscriber = SubscriberClient()
topics: list[str] = []
subscriptions: dict[str, str] = {}
run_id = uuid.UUID("11111111-2222-4333-8444-555555555555")
failed_at = datetime(2026, 10, 12, 6, 0, tzinfo=UTC)


def pull(subscription: str, expected: int) -> list[tuple[bytes, dict[str, str]]]:
    received: list[tuple[bytes, dict[str, str]]] = []
    ack_ids: list[str] = []
    for _ in range(6):
        response = subscriber.pull(
            request={"subscription": subscription, "max_messages": expected - len(received)},
            timeout=10,
        )
        for item in response.received_messages:
            received.append((item.message.data, dict(item.message.attributes)))
            ack_ids.append(item.ack_id)
        if len(received) == expected:
            break
    assert len(received) == expected, f"Expected {expected} messages, received {len(received)}"
    subscriber.acknowledge(request={"subscription": subscription, "ack_ids": ack_ids}, timeout=10)
    return received


try:
    for name in (signal_topic, dead_letter_topic):
        topic = admin.topic_path(project, name)
        admin.create_topic(request={"name": topic}, timeout=10)
        topics.append(topic)
        subscription = subscriber.subscription_path(project, f"review-{name}")
        subscriber.create_subscription(request={"name": subscription, "topic": topic}, timeout=10)
        subscriptions[name] = subscription

    # No client_factory: this is the real PublisherClient the deployed service would build.
    publisher = signal_publisher_from_environment(
        {
            "GOOGLE_CLOUD_PROJECT": project,
            "FIELDLOOP_ENV": "dev",
            "FIELDLOOP_ORG_ID": "fieldloop-demo",
        }
    )
    emitter = SimulatedSignalEmitter(publisher, org_id="fieldloop-demo")
    historian = SimulatedHistorian()
    historian.add_override("DL-01.rectifier.output", start=failed_at, value=0.0)
    reading = historian.observe("DL-01.rectifier.output", failed_at)

    # Delivery is at least once: a replayed observation must keep its identity.
    for _ in range(2):
        assert asyncio.run(emitter.emit(reading, run_id=run_id)).outcome == "published"
    refused = asyncio.run(publisher.publish({**emitter.build(reading), "simulated": False}))
    assert refused.outcome == "dead_lettered"

    # A patrol finding is a report that arrives as a Signal too: a Signal is Evidence that
    # arrives automatically from a connected source system, whatever its content.
    finding = SimulatedPatrol().observe("SYN-PATROL-001", failed_at)
    assert asyncio.run(emitter.emit(finding, run_id=run_id)).outcome == "published"

    delivered = pull(subscriptions[signal_topic], 3)
    bodies = [json.loads(data) for data, _ in delivered]
    historian = [item for item in bodies if item["source"] == "mock-historian"]
    patrol = [item for item in bodies if item["source"] == "mock-patrol"]
    assert len(historian) == 2 and len(patrol) == 1
    assert historian[0] == historian[1] and is_signal(historian[0]) and is_signal(patrol[0])
    assert patrol[0]["tag"] == "DL-01.encroachment.detected" and patrol[0]["value"] == 1
    assert patrol[0]["classification"] == "HIGHLY_RESTRICTED"
    assert patrol[0]["payload"]["findingId"] == "SYN-PATROL-001"
    body = historian[0]
    assert body["source"] == "mock-historian"
    assert body["tag"] == "DL-01.rectifier.output"
    assert body["value"] == 0
    assert body["unit"] == "A"
    assert body["observedAt"] == "2026-10-12T06:00:00Z"
    assert body["simulated"] is True
    assert body["simulationRunId"] == str(run_id)
    for data, attributes in delivered:
        assert attributes["environment"] == "dev"
        assert attributes["orgId"] == "fieldloop-demo"
        assert attributes["signalId"] == json.loads(data)["id"]
        assert attributes["simulated"] == "true"

    quarantined = pull(subscriptions[dead_letter_topic], 1)
    assert quarantined[0][1]["failureReason"] == "simulation_required"
    assert quarantined[0][1]["classification"] == "HIGHLY_RESTRICTED"
    print("Pub/Sub emulator: historian and patrol Signals delivered, replayed and quarantined")
finally:
    for subscription in subscriptions.values():
        subscriber.delete_subscription(request={"subscription": subscription}, timeout=10)
    for topic in topics:
        admin.delete_topic(request={"topic": topic}, timeout=10)
    admin.stop()
    subscriber.close()
