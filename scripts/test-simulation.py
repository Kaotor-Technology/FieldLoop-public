"""Verify durable player/reset, retries, concurrent commands and cold-start source hydration."""

import json
import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path

from fieldloop_common.generated_scenario import Scenario
from fieldloop_common.generated_simulation import PlayerCommand, RunCreate
from fieldloop_common.memory_transport import InMemoryTransport
from fieldloop_common.signal_publisher import SignalPublisher
from fieldloop_common.sql_connection import sql_connection_factory
from fieldloop_simulator.mock_historian import SimulatedHistorian
from fieldloop_simulator.mock_hydro import SimulatedHydro
from fieldloop_simulator.mock_pumps import SimulatedPumps
from fieldloop_simulator.mock_signals import SimulatedSignalEmitter
from fieldloop_simulator.player import ScenarioPlayer
from fieldloop_simulator.player_service import SimulationService
from fieldloop_simulator.player_store import PostgresPlayerStore
from fieldloop_simulator.scenario import load_catalog, load_scenario

root = Path(__file__).resolve().parents[1]
connect, close_connector = sql_connection_factory(os.environ)
org = "simulation-player-integration"
transport = InMemoryTransport()
emitter = SimulatedSignalEmitter(
    SignalPublisher(transport, environment="local", org_id=org, simulation_only=True), org_id=org
)
scenario = load_scenario(root / "apps/simulator/tests/fixtures/player.json")


def without_epoch(messages: list[dict[str, object]]) -> list[dict[str, object]]:
    return [
        {k: v for k, v in message.items() if k not in {"id", "simulationRunId"}}
        for message in messages
    ]


def make_service(selected: Scenario = scenario) -> tuple[SimulationService, PostgresPlayerStore]:
    store = PostgresPlayerStore(connect, org)
    player = ScenarioPlayer({selected.id: selected}, org, lambda: emitter)
    service = SimulationService(
        player,
        lambda: store,
        SimulatedHistorian(org_id=org),
        SimulatedHydro(org_id=org),
        SimulatedPumps(org_id=org),
    )
    return service, store


service, store = make_service()
latencies: list[float] = []
try:
    created = service.execute(
        "/runs", "create-player-fixture", RunCreate(scenarioId=scenario.id, seed=42, speed=1)
    )
    run_id = uuid.UUID(str(created["id"]))
    # Two simultaneous copies of one command publish once, even on separate service instances.
    other, other_store = make_service()
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            replies = list(
                pool.map(
                    lambda svc: svc.execute(
                        "/step", "same-command-id", PlayerCommand(), run_id, "step"
                    ),
                    [service, other],
                )
            )
        assert replies[0] == replies[1] and len(transport.messages) == 1
    finally:
        other_store.close()
    # A replacement process continues the pinned Scenario from the durable event index.
    store.close()
    service, store = make_service()
    assert service.current()["nextEventIndex"] == 1
    result = service.execute(
        "/bookmark", "jump-player-fixture", PlayerCommand(bookmarkId="failure"), run_id, "bookmark"
    )
    assert result["elapsedSeconds"] == 60 and len(transport.messages) == 3
    first = [json.loads(data)["value"] for _, data, _ in transport.messages]
    # The Demo B source read follows the durable run: the rain that the run published, as of
    # the run's clock, also in a process that has only just started.
    rain = service.hydro.read("rain")
    assert rain.value == first[2] and rain.observed_at.isoformat() == "2026-10-13T00:01:00+00:00"
    cold, cold_store = make_service()
    try:
        assert cold.hydro.read("rain").value == 0.0
        cold.hydrate_sources()
        assert cold.hydro.read("rain") == rain
    finally:
        cold_store.close()
    reset = service.execute("/reset", "reset-player-fixture", PlayerCommand(), run_id, "reset")
    assert (
        service.execute("/reset", "reset-player-fixture", PlayerCommand(), run_id, "reset") == reset
    )
    assert reset["id"] != created["id"] and reset["nextEventIndex"] == 0
    # Reset drops what the run held: no rain even at the time the old run had it.
    assert service.hydro.read("rain", rain.observed_at).value == 0.0
    result = service.execute(
        "/bookmark",
        "replay-player-fixture",
        PlayerCommand(bookmarkId="failure"),
        uuid.UUID(str(reset["id"])),
        "bookmark",
    )
    assert [json.loads(data)["value"] for _, data, _ in transport.messages][3:] == first
    for _ in range(25):
        started = time.perf_counter()
        assert service.current()["nextEventIndex"] == 3
        latencies.append((time.perf_counter() - started) * 1000)
    latencies.sort()
    print(
        "PASS: durable player, concurrent idempotency, reset/replay and cold start; "
        f"local read p50/p95={latencies[12]:.1f}/{latencies[23]:.1f} ms (25 samples)"
    )
    # Exercise the actual authored catalog through PostgreSQL persistence, not just a fixture.
    authored_catalog = load_catalog(root / "data/scenarios")
    assert set(authored_catalog) == {"cp-rectifier-failure", "bangkok-storm"}
    for authored in authored_catalog.values():
        current = service.current()
        assert current is not None
        service.execute(
            "/reset",
            f"prepare-{authored.id}",
            PlayerCommand(),
            uuid.UUID(str(current["id"])),
            "reset",
        )
        store.close()
        service, store = make_service(authored)
        created = service.execute(
            "/runs",
            f"create-{authored.id}",
            RunCreate(scenarioId=authored.id, seed=75, speed=60),
        )
        begin = len(transport.messages)
        service.execute(
            "/bookmark",
            f"complete-{authored.id}",
            PlayerCommand(bookmarkId="complete"),
            uuid.UUID(str(created["id"])),
            "bookmark",
        )
        first_run = [json.loads(data) for _, data, _ in transport.messages[begin:]]
        assert len(first_run) == len(authored.events)
        if authored.id == "bangkok-storm":
            starts_at = datetime.fromisoformat(authored.starts_at.replace("Z", "+00:00"))
            assert service.hydro.rain_accumulation(starts_at + timedelta(hours=2)) == 144
            assert service.pumps.power_at("P-3", starts_at + timedelta(seconds=7201)) == "lost"
        store.close()
        service, store = make_service(authored)
        assert service.current()["state"] == "finished"
        if authored.id == "bangkok-storm":
            assert service.hydro.rain_accumulation(starts_at + timedelta(hours=2)) == 144
            assert service.pumps.power_at("P-3", starts_at + timedelta(seconds=7201)) == "lost"
        reset = service.execute(
            "/reset",
            f"reset-{authored.id}",
            PlayerCommand(),
            uuid.UUID(str(created["id"])),
            "reset",
        )
        if authored.id == "bangkok-storm":
            assert service.hydro.rain_accumulation(starts_at + timedelta(hours=2)) == 0
            assert service.pumps.power_at("P-3", starts_at + timedelta(seconds=7201)) == "available"
        replay_begin = len(transport.messages)
        service.execute(
            "/bookmark",
            f"replay-{authored.id}",
            PlayerCommand(bookmarkId="complete"),
            uuid.UUID(str(reset["id"])),
            "bookmark",
        )
        replay = [json.loads(data) for _, data, _ in transport.messages[replay_begin:]]

        assert without_epoch(first_run) == without_epoch(replay)
        assert {s["id"] for s in first_run}.isdisjoint(s["id"] for s in replay)
        assert all(s["simulated"] and s["payload"]["sandbox"] for s in replay)
        print(
            f"PASS: {authored.id}; {len(replay)} authored Signals; durable cold-start/reset replay"
        )

finally:
    store.close()
    close_connector()
