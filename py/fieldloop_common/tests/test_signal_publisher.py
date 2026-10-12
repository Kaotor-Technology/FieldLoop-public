import asyncio
import json
from pathlib import Path

import pytest
from fieldloop_common.signal_publisher import SignalPublisher

CASES = json.loads(
    (
        Path(__file__).resolve().parents[3] / "packages/contracts/test/fixtures/signal-cases.json"
    ).read_text()
)


class RecordingTransport:
    def __init__(self, fail: bool = False) -> None:
        self.messages: list[tuple[str, bytes, dict[str, str]]] = []
        self.fail = fail

    async def publish(self, topic: str, data: bytes, attributes: dict[str, str]) -> str:
        self.messages.append((topic, data, attributes))
        if self.fail:
            raise RuntimeError("unavailable")
        return "message-73"


def publisher(transport: RecordingTransport, simulation_only: bool = False) -> SignalPublisher:
    return SignalPublisher(
        transport, environment="dev", org_id="fieldloop-demo", simulation_only=simulation_only
    )


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_shared_routing(case: dict[str, object]) -> None:
    transport = RecordingTransport()
    result = asyncio.run(publisher(transport).publish(case["signal"]))
    assert result.outcome == ("published" if case["valid"] else "dead_lettered")
    assert result.message_id == "message-73"
    assert len(transport.messages) == 1
    topic, data, attributes = transport.messages[0]
    assert topic == ("signals" if case["valid"] else "fieldloop-v2-dead-letter")
    assert json.loads(data) == case["signal"]
    assert attributes["environment"] == "dev"
    assert attributes["orgId"] == "fieldloop-demo"
    assert attributes["schemaVersion"] == "signal.v1"
    if not case["valid"]:
        assert attributes["failureReason"] == "validation_failed"
        assert attributes["classification"] == "HIGHLY_RESTRICTED"


@pytest.mark.parametrize("value", [10**309, -(10**309)])
def test_out_of_range_integers_go_only_to_quarantine(value: int) -> None:
    signal = {**CASES[0]["signal"], "value": value}
    transport = RecordingTransport()
    result = asyncio.run(publisher(transport).publish(signal))
    assert result.outcome == "dead_lettered"
    assert len(transport.messages) == 1
    topic, data, attributes = transport.messages[0]
    assert topic == "fieldloop-v2-dead-letter"
    assert json.loads(data) == signal
    assert attributes["failureReason"] == "validation_failed"
    assert attributes["classification"] == "HIGHLY_RESTRICTED"


def test_simulation_and_organisation_guards() -> None:
    transport = RecordingTransport()
    instance = publisher(transport, simulation_only=True)
    asyncio.run(instance.publish({**CASES[0]["signal"], "simulated": False}))
    assert transport.messages[0][2]["failureReason"] == "simulation_required"
    asyncio.run(instance.publish({**CASES[0]["signal"], "orgId": "other-org"}))
    assert transport.messages[1][2]["failureReason"] == "org_mismatch"
    assert transport.messages[1][2]["orgId"] == "fieldloop-demo"


@pytest.mark.parametrize("signal", [CASES[0]["signal"], {}])
def test_transport_errors_propagate(signal: object) -> None:
    transport = RecordingTransport(fail=True)
    with pytest.raises(RuntimeError, match="unavailable"):
        asyncio.run(publisher(transport).publish(signal))
    assert len(transport.messages) == 1


def test_retry_keeps_identity_and_provenance() -> None:
    transport = RecordingTransport()
    instance = publisher(transport)
    signal = CASES[0]["signal"]
    before = json.dumps(signal)
    asyncio.run(instance.publish(signal))
    asyncio.run(instance.publish(signal))
    assert transport.messages[0] == transport.messages[1]
    assert json.dumps(signal) == before


@pytest.mark.parametrize(
    "signal",
    [float("nan"), float("inf"), {"x": float("nan")}, {1: "x"}, object(), (1,), "x" * (256 * 1024)],
)
def test_non_json_or_oversized_input_never_reaches_transport(signal: object) -> None:
    transport = RecordingTransport()
    with pytest.raises((TypeError, ValueError)):
        asyncio.run(publisher(transport).publish(signal))
    assert transport.messages == []


def test_cycle_never_reaches_transport() -> None:
    signal: dict[str, object] = {}
    signal["self"] = signal
    transport = RecordingTransport()
    with pytest.raises(ValueError):
        asyncio.run(publisher(transport).publish(signal))
    assert transport.messages == []


def test_bad_config() -> None:
    transport = RecordingTransport()
    with pytest.raises(ValueError):
        SignalPublisher(
            transport, environment="unknown", org_id="fieldloop-demo", simulation_only=True
        )
    with pytest.raises(ValueError):
        SignalPublisher(transport, environment="dev", org_id="", simulation_only=True)
    with pytest.raises(ValueError):
        SignalPublisher(
            transport,
            environment="dev",
            org_id="fieldloop-demo",
            simulation_only=True,
            dead_letter_topic="signals",
        )


@pytest.mark.parametrize(
    ("signal_topic", "dead_letter_topic"),
    [
        ("signals", "projects/test-project/topics/signals"),
        ("projects/test-project/topics/signals", "signals"),
        ("projects/test-project/topics/signals", "projects/test-project/topics/dead-letter"),
        ("signals ", "dead-letter"),
        ("signals", " dead-letter"),
    ],
)
def test_topic_aliases_and_non_canonical_names_are_rejected(
    signal_topic: str, dead_letter_topic: str
) -> None:
    transport = RecordingTransport()
    with pytest.raises(ValueError):
        SignalPublisher(
            transport,
            environment="dev",
            org_id="fieldloop-demo",
            simulation_only=True,
            signal_topic=signal_topic,
            dead_letter_topic=dead_letter_topic,
        )
    assert transport.messages == []
