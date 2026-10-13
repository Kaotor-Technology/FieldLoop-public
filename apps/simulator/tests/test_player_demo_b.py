"""A Demo B run end to end in process: the Signals it publishes and the reads that follow it."""

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
        self.emitter = emitter = SimulatedSignalEmitter(publisher, org_id="test-org")
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


def rule(identifier: str) -> dict[str, Any]:
    golden = json.loads((ROOT / "domain-packs/flood-water/golden.json").read_text())
    (found,) = [item for item in golden["rules"] if item["id"] == identifier]
    return dict(found)


@pytest.fixture
def run() -> Run:
    started = Run(load_scenario(FIXTURE))
    started.create()
    return started


def test_a_run_publishes_the_pump_signal_that_the_flood_pack_rule_matches(run: Run) -> None:
    run.play_to_the_end()
    signal = run.signals()["pump-loses-power"]
    matched = rule("pump-power-lost")

    assert (signal["source"], signal["tag"], signal["value"], signal["unit"]) == (
        matched["source"],
        matched["tag"],
        matched["threshold"],
        matched["unit"],
    )
    assert signal["observedAt"] == "2026-10-12T00:20:00Z"
    # The author wrote no payload: the source states it, and the player adds its envelope.
    assert signal["payload"] == {
        "assetCode": "P-3",
        "facilityType": "pump",
        "zone": "Z3",
        "operatingState": "stopped",
        "label": "SIMULATION",
        "target": {"kind": "asset", "id": "P-3"},
        "sandbox": True,
    }
    assert (signal["simulated"], signal["classification"]) == (True, "CONFIDENTIAL")


def test_a_run_publishes_the_rainfall_that_crosses_the_flood_pack_rule(run: Run) -> None:
    run.play_to_the_end()
    signals = run.signals()
    after_one_hour, after_two_hours = signals["rainfall-after-1h"], signals["rainfall-after-2h"]
    matched = rule("rainfall-needs-fresh-evidence")

    assert matched["operator"] == "gt"
    assert after_one_hour["value"] == 60
    assert after_one_hour["value"] <= matched["threshold"]
    assert after_two_hours["value"] == 120
    assert after_two_hours["value"] > matched["threshold"]
    assert (after_two_hours["source"], after_two_hours["tag"], after_two_hours["unit"]) == (
        matched["source"],
        matched["tag"],
        matched["unit"],
    )
    assert after_two_hours["payload"] == {
        "assetCode": "S-R1",
        "zone": "Z3",
        "kind": "rain",
        "windowSeconds": matched["windowSeconds"],
        "label": "SIMULATION",
        "target": {"kind": "asset", "id": "S-R1"},
        "sandbox": True,
    }


def test_the_rainfall_is_summed_from_the_rain_as_published_noise_included() -> None:
    scenario = load_scenario(FIXTURE)
    noisy = scenario.events[0].model_copy(update={"noise_amplitude": 5.0})
    run = Run(scenario.model_copy(update={"events": [noisy, *scenario.events[1:]]}))
    run.create()
    run.play_to_the_end()
    signals = run.signals()

    rate = signals["rain-starts"]["value"]
    assert rate != 60
    assert 55 <= rate <= 65
    assert signals["rainfall-after-1h"]["value"] == pytest.approx(rate)
    assert signals["rainfall-after-2h"]["value"] == pytest.approx(2 * rate)


def test_an_author_cannot_contradict_what_the_source_says_about_itself() -> None:
    scenario = load_scenario(FIXTURE)
    edited = scenario.events[0].model_copy(update={"payload": {"zone": "Z9", "note": "squall"}})
    run = Run(scenario.model_copy(update={"events": [edited, *scenario.events[1:]]}))
    run.create()
    run.command("step")

    payload = run.signals()["rain-starts"]["payload"]
    assert payload["zone"] == "Z3"
    assert payload["note"] == "squall"


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
    # The source sums what the run applied, and agrees with the Signal the run published.
    assert run.hydro.rain_accumulation(START + timedelta(hours=2)) == 120
    assert run.signals()["rainfall-after-2h"]["value"] == 120


def test_a_run_and_its_sources_state_one_signal_with_one_id(run: Run) -> None:
    run.play_to_the_end()
    signals = run.signals()
    stated = {
        "rain-starts": run.hydro.observe("rain", START),
        "pump-loses-power": run.pumps.observe("P-3", POWER_LOST),
        "rainfall-after-2h": run.hydro.observe_rain_accumulation(START + timedelta(hours=2)),
        "canal-rises": run.hydro.observe("level", START + timedelta(hours=3)),
    }
    for event_id, observation in stated.items():
        signal = signals[event_id]
        assert (signal["source"], signal["tag"], signal["value"], signal["unit"]) == (
            observation.source,
            observation.tag,
            observation.value,
            observation.unit,
        ), event_id
        assert signal["classification"] == observation.classification, event_id
        # One reading has one id, whoever publishes it.
        assert signal["id"] == run.emitter.build(observation, run.run_id)["id"], event_id
        # The run adds what only it knows: the Scenario target and the sandbox mark.
        envelope = {"target": signal["payload"]["target"], "sandbox": True}
        assert signal["payload"] == {**(observation.payload or {}), **envelope}, event_id


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
