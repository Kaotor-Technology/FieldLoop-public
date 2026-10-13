import json
from datetime import datetime
from pathlib import Path

from fieldloop_simulator.bangkok_storm import SIMULATION_STARTS_AT

ROOT = Path(__file__).resolve().parents[3]


def test_the_default_scenario_time_is_the_start_of_the_bangkok_simulation() -> None:
    bowtie = json.loads((ROOT / "data/synthetic/bangkok/bowtie-d.json").read_text())
    assert datetime.fromisoformat(bowtie["metadata"]["simulationStartsAt"]) == SIMULATION_STARTS_AT
