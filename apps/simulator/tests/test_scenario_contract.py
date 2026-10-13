"""What the Scenario player (FL-74) may rely on, driven in process through the app.

A stand-in plays the player: it takes the sources that ``main`` puts on ``app.state``, changes
one, announces the change as a Signal and starts the next run. No source API publishes, so
nothing here goes through a GET (SIM-3; FL-24 D05 is read the same way).
"""

import asyncio
import json
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from fieldloop_common.memory_transport import InMemoryTransport
from fieldloop_common.signal import parse_signal
from fieldloop_common.signal_publisher import SignalPublisher
from fieldloop_simulator.main import app
from fieldloop_simulator.mock_cmms import SimulatedCmms
from fieldloop_simulator.mock_historian import SimulatedHistorian
from fieldloop_simulator.mock_ili import SimulatedIliDrop
from fieldloop_simulator.mock_patrol import SimulatedPatrol
from fieldloop_simulator.mock_signals import SimulatedSignalEmitter

RECTIFIER = "DL-01.rectifier.output"
RUN = uuid.UUID("22222222-3333-4444-8555-666666666666")
FAILURE = datetime(2026, 10, 12, 0, 2, tzinfo=UTC)
WINDOW = {"from": "2026-10-12T00:00:00Z", "to": "2026-10-12T00:05:00Z"}

Player = tuple[SimulatedSignalEmitter, InMemoryTransport]


@pytest.fixture
def player() -> Iterator[Player]:
    historian: SimulatedHistorian = app.state.historian
    historian.reset()
    transport = InMemoryTransport()
    publisher = SignalPublisher(
        transport, environment="dev", org_id=historian.org_id, simulation_only=True
    )
    yield SimulatedSignalEmitter(publisher, org_id=historian.org_id), transport
    historian.reset()


def readings(client: TestClient) -> dict[str, float]:
    points = client.get(f"/mock/historian/tags/{RECTIFIER}", params=WINDOW).json()["points"]
    return {point["timestamp"]: point["value"] for point in points}


def test_every_source_is_on_the_app_for_the_player() -> None:
    assert isinstance(app.state.historian, SimulatedHistorian)
    assert isinstance(app.state.cmms, SimulatedCmms)
    assert isinstance(app.state.patrol, SimulatedPatrol)
    assert isinstance(app.state.ili, SimulatedIliDrop)


def test_a_failure_changes_the_reads_and_is_announced_as_one_signal(player: Player) -> None:
    emitter, transport = player
    historian: SimulatedHistorian = app.state.historian
    with TestClient(app) as client:
        baseline = readings(client)
        assert min(baseline.values()) > 0
        assert transport.messages == []

        historian.add_override(RECTIFIER, start=FAILURE, value=0.0)
        outcome = asyncio.run(emitter.emit(historian.observe(RECTIFIER, FAILURE), run_id=RUN))
        failed = readings(client)
        readings(client)  # reading again is not a command, so it publishes nothing

    assert outcome.outcome == "published"
    assert failed["2026-10-12T00:01:00Z"] == baseline["2026-10-12T00:01:00Z"]
    assert failed["2026-10-12T00:02:00Z"] == 0
    ((topic, data, attributes),) = transport.messages
    signal = json.loads(data)
    parse_signal(signal)
    assert (topic, attributes["environment"], attributes["simulated"]) == ("signals", "dev", "true")
    assert (signal["source"], signal["tag"], signal["value"], signal["unit"]) == (
        "mock-historian",
        RECTIFIER,
        0,
        "A",
    )
    assert signal["observedAt"] == "2026-10-12T00:02:00Z"
    assert signal["simulationRunId"] == str(RUN)


def test_the_next_run_starts_from_the_baseline_and_a_replay_keeps_its_signal_id(
    player: Player,
) -> None:
    emitter, transport = player
    historian: SimulatedHistorian = app.state.historian
    with TestClient(app) as client:
        baseline = readings(client)
        for _ in range(2):
            historian.reset()
            assert readings(client) == baseline
            historian.add_override(RECTIFIER, start=FAILURE, value=0.0)
            asyncio.run(emitter.emit(historian.observe(RECTIFIER, FAILURE), run_id=RUN))

    identities = [json.loads(data)["id"] for _, data, _ in transport.messages]
    assert len(identities) == 2
    assert identities[0] == identities[1]


def test_a_signal_is_never_labelled_below_what_its_source_api_reports(player: Player) -> None:
    emitter, transport = player
    at = datetime(2026, 10, 12, 9, 0, tzinfo=UTC)
    with TestClient(app) as client:
        reported = {
            "mock-historian": client.get(f"/mock/historian/tags/{RECTIFIER}", params=WINDOW).json()[
                "classification"
            ],
            "mock-patrol": client.get("/mock/patrol/findings").json()["classification"],
            "mock-ili": client.get("/mock/ili/reports/SYN-ILI-2026-001").json()["classification"],
        }
    observations = [
        app.state.historian.observe(RECTIFIER, at),
        app.state.patrol.observe("SYN-PATROL-001", at),
        app.state.ili.observe("SYN-ILI-2026-001", at),
    ]
    for observation in observations:
        asyncio.run(emitter.emit(observation, run_id=RUN))

    signals = [json.loads(data) for _, data, _ in transport.messages]
    assert {signal["source"]: signal["classification"] for signal in signals} == reported
    assert all(signal["simulated"] is True for signal in signals)
