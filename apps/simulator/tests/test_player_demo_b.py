"""A Demo B run in process: the reads of the two sources follow what the run has applied."""

import json
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from fieldloop_common.generated_scenario import Event, Scenario
from fieldloop_common.generated_simulation import PlayerCommand, RunCreate
from fieldloop_common.memory_transport import InMemoryTransport
from fieldloop_common.signal import parse_signal
from fieldloop_common.signal_publisher import SignalPublisher
from fieldloop_simulator.main import app
from fieldloop_simulator.mock_historian import SimulatedHistorian
from fieldloop_simulator.mock_hydro import SimulatedHydro
from fieldloop_simulator.mock_pumps import SimulatedPumps
from fieldloop_simulator.mock_signals import SimulatedSignalEmitter
from fieldloop_simulator.player import PlayerSnapshot, ScenarioPlayer
from fieldloop_simulator.player_service import SimulationService
from fieldloop_simulator.scenario import load_scenario

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = Path(__file__).parent / "fixtures/player-demo-b.json"
START = datetime(2026, 10, 12, tzinfo=UTC)
POWER_LOST = START + timedelta(minutes=20)


class MemoryStore:
    """The committed run of one Organisation, kept in memory; it outlives a service."""

    def __init__(self) -> None:
        self.snapshot: PlayerSnapshot | None = None
        self._responses: dict[str, dict[str, object]] = {}

    @contextmanager
    def transaction(self) -> Iterator["MemoryStore"]:
        yield self

    def restore_baseline(self) -> None:
        pass  # nothing else is stored here

    def save(self, snapshot: PlayerSnapshot) -> None:
        self.snapshot = snapshot

    def lookup(self, key: str, digest: str) -> dict[str, object] | None:
        return self._responses.get(key)

    def remember(self, key: str, digest: str, response: dict[str, object]) -> None:
        self._responses[key] = response


class Run:
    """One service over an in-memory store, with the sources it drives and what it published."""

    def __init__(self, scenario: Scenario, store: MemoryStore | None = None) -> None:
        self.transport = InMemoryTransport()
        publisher = SignalPublisher(
            self.transport, environment="local", org_id="test-org", simulation_only=True
        )
        emitter = SimulatedSignalEmitter(publisher, org_id="test-org")
        self.store = store or MemoryStore()
        self.hydro = SimulatedHydro(org_id="test-org")
        self.pumps = SimulatedPumps(org_id="test-org")
        player = ScenarioPlayer({scenario.id: scenario}, "test-org", lambda: emitter, lambda: START)
        self.service = SimulationService(
            player,
            lambda: self.store,
            SimulatedHistorian(org_id="test-org"),
            self.hydro,
            self.pumps,
        )
        self.scenario = scenario
        self.run_id: UUID | None = None
        self._commands = 0

    def create(self) -> None:
        body = RunCreate(scenarioId=self.scenario.id, seed=42, speed=1)
        self.run_id = UUID(str(self.service.execute("/v1/simulation/runs", "create", body)["id"]))

    def command(self, name: str, body: dict[str, object] | None = None) -> dict[str, object]:
        assert self.run_id is not None
        self._commands += 1
        response = self.service.execute(
            f"/v1/simulation/runs/{self.run_id}:{name}",
            f"demo-b-command-{self._commands:04d}",
            PlayerCommand.model_validate(body or {}),
            self.run_id,
            name,  # type: ignore[arg-type]
        )
        self.run_id = UUID(str(response["id"]))  # a reset retires the run and starts another
        return response

    def play_to_the_end(self) -> None:
        # However many events one step takes, stepping ends when every event is published.
        while self.command("step")["nextEventIndex"] != len(self.scenario.events):
            pass

    def signals(self) -> dict[str, dict[str, Any]]:
        """The published Signals by the Scenario event that caused each."""
        published = [json.loads(data) for _, data, _ in self.transport.messages]
        for signal in published:
            parse_signal(signal)
        applied = self.scenario.events[: len(published)]
        return {event.id: signal for event, signal in zip(applied, published, strict=True)}


@pytest.fixture
def run() -> Run:
    started = Run(load_scenario(FIXTURE))
    started.create()
    return started


def test_reads_of_the_sources_follow_the_run(run: Run) -> None:
    assert run.hydro.value_at("rain", START) == 0.0
    assert run.pumps.power_at("P-3", POWER_LOST) == "available"

    run.command("bookmark", {"bookmarkId": "power-lost"})
    assert run.hydro.value_at("rain", START) == 60.0
    assert run.pumps.power_at("P-3", POWER_LOST - timedelta(seconds=1)) == "available"
    assert run.pumps.power_at("P-3", POWER_LOST) == "lost"
    assert run.pumps.operating_state_at("P-3", POWER_LOST) == "stopped"
    assert run.pumps.power_at("P-1", POWER_LOST) == "available"
    # Not yet applied: the canal rises three hours in.
    assert run.hydro.value_at("level", START + timedelta(hours=3)) == 0.6

    run.play_to_the_end()
    assert run.hydro.value_at("rain", START + timedelta(hours=3)) == 10.0
    assert run.hydro.value_at("level", START + timedelta(hours=3)) == 1.9
    assert run.hydro.rain_accumulation(START + timedelta(hours=2)) == 120


def test_a_reset_returns_the_reads_to_their_baseline(run: Run) -> None:
    run.play_to_the_end()
    run.command("reset")

    assert run.hydro.value_at("rain", START + timedelta(hours=1)) == 0.0
    assert run.hydro.value_at("level", START + timedelta(hours=3)) == 0.6
    assert run.pumps.power_at("P-3", POWER_LOST) == "available"


def test_a_cold_start_rebuilds_the_reads_from_the_committed_run(run: Run) -> None:
    run.command("bookmark", {"bookmarkId": "power-lost"})

    restarted = Run(run.scenario, store=run.store)
    assert restarted.pumps.power_at("P-3", POWER_LOST) == "available"
    restarted.service.hydrate_sources()

    assert restarted.pumps.power_at("P-3", POWER_LOST) == "lost"
    assert restarted.hydro.value_at("rain", START) == 60.0
    assert restarted.transport.messages == []  # rebuilding the reads publishes nothing


def test_a_run_pinned_with_an_event_the_source_cannot_hold_still_serves_its_reads() -> None:
    # A pinned run keeps the Scenario it was created with, however the rules change later.
    scenario = load_scenario(FIXTURE)
    stale = [
        Event.model_validate(
            {
                "id": "old-rain",
                "atSeconds": 0,
                "source": "mock-hydro",
                "target": {"kind": "asset", "id": "S-R1"},
                "tag": "rain.intensity",
                "value": 60,
                "unit": "mm/h",
            }
        ),
        Event.model_validate(
            {
                "id": "old-pump",
                "atSeconds": 0,
                "source": "mock-pumps",
                "target": {"kind": "asset", "id": "P-9"},
                "tag": "pump.power",
                "value": "lost",
            }
        ),
    ]
    run = Run(scenario.model_copy(update={"events": stale}))
    run.create()
    run.play_to_the_end()

    assert len(run.transport.messages) == 2  # the player still publishes what it was given
    assert run.hydro.value_at("rain", START) == 0.0
    assert run.pumps.power_at("P-3", START) == "available"


def test_the_app_drives_the_sources_that_its_routes_read() -> None:
    assert app.state.simulation.hydro is app.state.hydro
    assert app.state.simulation.pumps is app.state.pumps
