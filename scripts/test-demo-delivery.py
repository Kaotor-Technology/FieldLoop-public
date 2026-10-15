"""Emit untouched authored Scenario envelopes for the local delivery integration test."""

import argparse
import base64
import json
import os
import uuid
from pathlib import Path

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
from fieldloop_simulator.scenario import load_catalog

parser = argparse.ArgumentParser()
parser.add_argument("scenario", choices=["cp-rectifier-failure", "bangkok-storm"])
parser.add_argument("action", choices=["run", "reset", "replay"])
args = parser.parse_args()
org = "demo-bridge-" + args.scenario
catalog = load_catalog(Path(__file__).resolve().parents[1] / "data/scenarios")
scenario = catalog[args.scenario]
connect, close_connector = sql_connection_factory(os.environ)
transport = InMemoryTransport()
emitter = SimulatedSignalEmitter(
    SignalPublisher(transport, environment="local", org_id=org, simulation_only=True), org_id=org
)
store = PostgresPlayerStore(connect, org)
service = SimulationService(
    ScenarioPlayer({scenario.id: scenario}, org, lambda: emitter),
    lambda: store,
    SimulatedHistorian(org_id=org),
    SimulatedHydro(org_id=org),
    SimulatedPumps(org_id=org),
)
try:
    current = service.current()
    if args.action == "run":
        assert current is None
        current = service.execute(
            "/runs", "bridge-create", RunCreate(scenarioId=scenario.id, seed=75, speed=60)
        )
    else:
        assert current is not None
    if args.action == "reset":
        assert current["state"] == "finished", "cold-start must recover the completed run"
        current = service.execute(
            "/reset", "bridge-reset", PlayerCommand(), uuid.UUID(str(current["id"])), "reset"
        )
    else:
        current = service.execute(
            "/bookmark",
            "bridge-" + args.action,
            PlayerCommand(bookmarkId="complete"),
            uuid.UUID(str(current["id"])),
            "bookmark",
        )
        assert len(transport.messages) == len(scenario.events)
    print(
        json.dumps(
            {
                "run": current,
                "startsAt": scenario.starts_at,
                "messages": [
                    {
                        "topic": topic,
                        "data": base64.b64encode(data).decode("ascii"),
                        "attributes": attrs,
                    }
                    for topic, data, attrs in transport.messages
                ],
            }
        )
    )
finally:
    store.close()
    close_connector()
