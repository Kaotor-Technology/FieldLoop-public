import asyncio
import json
import re
import uuid
from datetime import UTC, datetime, timedelta, timezone
from unittest.mock import create_autospec

import pytest
from fieldloop_common.memory_transport import InMemoryTransport
from fieldloop_common.signal import parse_signal
from fieldloop_common.signal_publisher import SignalPublisher
from fieldloop_simulator.mock_historian import SimulatedHistorian
from fieldloop_simulator.mock_signals import (
    Observation,
    SimulatedSignalEmitter,
    signal_publisher_from_environment,
)
from google.cloud.pubsub_v1 import PublisherClient

RECTIFIER = "DL-01.rectifier.output"
AT = datetime(2026, 10, 12, 6, 0, tzinfo=UTC)
RUN = uuid.UUID("11111111-2222-4333-8444-555555555555")
UUID_TEXT = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def observation(**changes: object) -> Observation:
    values: dict[str, object] = {
        "source": "mock-historian",
        "classification": "CONFIDENTIAL",
        "tag": RECTIFIER,
        "value": 12.4,
        "observed_at": AT,
        "unit": "A",
        "payload": {"assetCode": "DL-01"},
    }
    return Observation(**(values | changes))


def test_observation_becomes_a_valid_signal_v1_message(
    emitter: SimulatedSignalEmitter,
) -> None:
    signal = emitter.build(observation(), run_id=RUN)
    assert signal == {
        "schemaVersion": "signal.v1",
        "id": signal["id"],
        "orgId": "fieldloop-demo",
        "source": "mock-historian",
        "tag": RECTIFIER,
        "value": 12.4,
        "unit": "A",
        "observedAt": "2026-10-12T06:00:00Z",
        "simulated": True,
        "classification": "CONFIDENTIAL",
        "simulationRunId": str(RUN),
        "payload": {"assetCode": "DL-01"},
    }
    assert UUID_TEXT.fullmatch(str(signal["id"]))
    parse_signal(signal)


def test_optional_members_are_omitted_when_absent(emitter: SimulatedSignalEmitter) -> None:
    signal = emitter.build(observation(unit=None, payload=None))
    assert set(signal) == {
        "schemaVersion",
        "id",
        "orgId",
        "source",
        "tag",
        "value",
        "observedAt",
        "simulated",
        "classification",
    }
    parse_signal(signal)


def test_offset_observation_times_are_sent_as_utc(emitter: SimulatedSignalEmitter) -> None:
    plus_seven = timezone(timedelta(hours=7))
    signal = emitter.build(observation(observed_at=AT.astimezone(plus_seven)))
    assert signal["observedAt"] == "2026-10-12T06:00:00Z"


def test_naive_observation_times_are_rejected(emitter: SimulatedSignalEmitter) -> None:
    with pytest.raises(ValueError, match="timezone"):
        emitter.build(observation(observed_at=datetime(2026, 10, 12, 6, 0)))  # noqa: DTZ001


@pytest.mark.parametrize(
    "observed_at",
    [
        datetime(1, 1, 1, tzinfo=timezone(timedelta(hours=5))),
        datetime(9999, 12, 31, 23, tzinfo=timezone(timedelta(hours=-5))),
    ],
)
def test_observation_times_outside_the_utc_range_are_rejected(
    emitter: SimulatedSignalEmitter, observed_at: datetime
) -> None:
    with pytest.raises(ValueError, match="range"):
        emitter.build(observation(observed_at=observed_at))


def test_signal_identity_is_stable_for_replay_and_distinct_otherwise(
    emitter: SimulatedSignalEmitter,
) -> None:
    first = emitter.build(observation(), run_id=RUN)["id"]
    assert emitter.build(observation(), run_id=RUN)["id"] == first
    assert emitter.build(observation(), run_id=None)["id"] != first
    assert emitter.build(observation(), run_id=uuid.uuid4())["id"] != first
    assert emitter.build(observation(value=0), run_id=RUN)["id"] != first
    later = observation(observed_at=AT + timedelta(seconds=1))
    assert emitter.build(later, run_id=RUN)["id"] != first
    assert emitter.build(observation(tag="DL-01.flow.line"), run_id=RUN)["id"] != first
    # The source takes part too: the same reading from another source is another Signal.
    assert emitter.build(observation(source="mock-other"), run_id=RUN)["id"] != first


def test_equal_json_numbers_share_one_identity(emitter: SimulatedSignalEmitter) -> None:
    # An override held as 0.0 and a reading of 0 are the same observation on replay.
    instance = emitter
    assert (
        instance.build(observation(value=0), run_id=RUN)["id"]
        == instance.build(observation(value=0.0), run_id=RUN)["id"]
    )
    assert (
        instance.build(observation(value=12.0), run_id=RUN)["id"]
        == instance.build(observation(value=12), run_id=RUN)["id"]
    )
    assert (
        instance.build(observation(value=12.5), run_id=RUN)["id"]
        != instance.build(observation(value=12), run_id=RUN)["id"]
    )
    assert (
        instance.build(observation(value=True), run_id=RUN)["id"]
        != instance.build(observation(value=1), run_id=RUN)["id"]
    )


def test_the_subject_takes_part_in_the_identity(emitter: SimulatedSignalEmitter) -> None:
    instance = emitter
    plain = instance.build(observation(), run_id=RUN)["id"]
    first = instance.build(observation(subject="SYN-PATROL-001"), run_id=RUN)["id"]
    second = instance.build(observation(subject="SYN-PATROL-004"), run_id=RUN)["id"]
    assert len({plain, first, second}) == 3
    assert instance.build(observation(subject="SYN-PATROL-001"), run_id=RUN)["id"] == first


def test_emit_publishes_to_the_signal_topic_with_routing_attributes(
    emitter: SimulatedSignalEmitter, transport: InMemoryTransport
) -> None:
    result = asyncio.run(emitter.emit(observation(), run_id=RUN))
    assert result.outcome == "published"
    assert len(transport.messages) == 1
    topic, data, attributes = transport.messages[0]
    assert topic == "signals"
    signal = json.loads(data)
    assert attributes == {
        "environment": "dev",
        "orgId": "fieldloop-demo",
        "schemaVersion": "signal.v1",
        "signalId": signal["id"],
        "simulated": "true",
        "classification": "CONFIDENTIAL",
    }
    assert signal["simulated"] is True


def test_an_organisation_mismatch_is_quarantined_not_published(
    publisher: SignalPublisher, transport: InMemoryTransport
) -> None:
    other = SimulatedSignalEmitter(publisher, org_id="other-org")
    result = asyncio.run(other.emit(observation()))
    assert result.outcome == "dead_lettered"
    topic, _, attributes = transport.messages[0]
    assert topic == "fieldloop-v2-dead-letter"
    assert attributes["failureReason"] == "org_mismatch"


@pytest.mark.parametrize("value", [float("nan"), float("inf")])
def test_non_finite_values_raise_before_any_transport_call(
    emitter: SimulatedSignalEmitter, transport: InMemoryTransport, value: float
) -> None:
    # The generated Signal model refuses them while the envelope is built.
    with pytest.raises(ValueError, match="value"):
        asyncio.run(emitter.emit(observation(value=value)))
    assert transport.messages == []


def test_a_scenario_override_reaches_the_platform_as_a_zero_rectifier_signal(
    emitter: SimulatedSignalEmitter, transport: InMemoryTransport
) -> None:
    historian = SimulatedHistorian(seed=3)
    historian.add_override(RECTIFIER, start=AT, value=0.0)
    asyncio.run(emitter.emit(historian.observe(RECTIFIER, AT), run_id=RUN))
    signal = json.loads(transport.messages[0][1])
    # The shape the pipeline pack rule matches: source mock-historian, this tag, eq 0, unit A.
    assert signal["source"] == "mock-historian"
    assert signal["tag"] == RECTIFIER
    assert signal["value"] == 0
    assert signal["unit"] == "A"
    assert signal["payload"]["assetCode"] == "DL-01"
    assert signal["payload"]["label"] == "SYNTHETIC"
    parse_signal(signal)


def test_historian_observations_carry_the_profile_unit_and_baseline() -> None:
    historian = SimulatedHistorian()
    seen = historian.observe("DL-01.pressure.line", AT)
    assert seen.unit == "bar"
    assert seen.value == historian.value_at("DL-01.pressure.line", AT)
    assert seen.observed_at == AT


def test_environment_configuration_builds_a_simulation_only_publisher() -> None:
    client = create_autospec(PublisherClient, instance=True)
    client.topic_path.side_effect = lambda project, topic: f"projects/{project}/topics/{topic}"
    client.publish.return_value.result.return_value = "sdk-message"
    publisher = signal_publisher_from_environment(
        {
            "FIELDLOOP_ENV": "demo",
            "FIELDLOOP_ORG_ID": "fieldloop-demo",
            "GOOGLE_CLOUD_PROJECT": "p",
        },
        client_factory=lambda: client,
    )
    instance = SimulatedSignalEmitter(publisher, org_id="fieldloop-demo")
    result = asyncio.run(instance.emit(observation(), run_id=RUN))
    assert result.outcome == "published"
    assert result.message_id == "sdk-message"
    path, data = client.publish.call_args.args
    assert path == "projects/p/topics/signals"
    assert client.publish.call_args.kwargs["environment"] == "demo"
    assert json.loads(data)["orgId"] == "fieldloop-demo"
    # Mock mode: a real-labelled observation is refused by the publisher, never sent to signals.
    real = {**json.loads(data), "simulated": False}
    refused = asyncio.run(publisher.publish(real))
    assert refused.outcome == "dead_lettered"
    assert client.publish.call_args.args[0] == "projects/p/topics/fieldloop-v2-dead-letter"


def test_default_client_is_the_real_sdk_and_needs_no_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Emulator mode builds the real PublisherClient without ADC and opens no connection.
    monkeypatch.setenv("PUBSUB_EMULATOR_HOST", "127.0.0.1:9")
    publisher = signal_publisher_from_environment({"GOOGLE_CLOUD_PROJECT": "p"})
    assert isinstance(publisher, SignalPublisher)


def test_environment_defaults_are_local_and_the_demo_organisation(
    emitter: SimulatedSignalEmitter,
) -> None:
    client = create_autospec(PublisherClient, instance=True)
    client.topic_path.side_effect = lambda project, topic: f"projects/{project}/topics/{topic}"
    client.publish.return_value.result.return_value = "sdk-message"
    publisher = signal_publisher_from_environment(
        {"GOOGLE_CLOUD_PROJECT": "p"}, client_factory=lambda: client
    )
    asyncio.run(publisher.publish(emitter.build(observation())))
    assert client.publish.call_args.kwargs["environment"] == "local"
    assert client.publish.call_args.kwargs["orgId"] == "fieldloop-demo"


@pytest.mark.parametrize(
    "environ",
    [
        {},
        {"GOOGLE_CLOUD_PROJECT": " "},
        {"GOOGLE_CLOUD_PROJECT": "p", "FIELDLOOP_ENV": "production"},
        {"GOOGLE_CLOUD_PROJECT": "p", "FIELDLOOP_ORG_ID": "not valid"},
    ],
)
def test_invalid_environment_configuration_fails_closed(environ: dict[str, str]) -> None:
    client = create_autospec(PublisherClient, instance=True)
    with pytest.raises(ValueError, match="project|configuration|Organisation"):
        signal_publisher_from_environment(environ, client_factory=lambda: client)
    client.publish.assert_not_called()
