"""Export real Demo B player snapshots for the web rain acceptance tests."""

import json
from datetime import timedelta
from typing import Any

from fieldloop_simulator.player import Command
from fieldloop_simulator.scenario import load_scenario

from apps.simulator.tests.test_demo_scenarios import CATALOG, command, harness


def rain_replay() -> dict[str, Any]:
    scenario = load_scenario(CATALOG / "bangkok-storm.yaml")
    player, tx, transport, now = harness(scenario)
    assert tx.snapshot is not None
    snapshots = {"ready": tx.snapshot.run.model_dump(mode="json", by_alias=True)}

    def capture(name: str, action: Command) -> None:
        run = command(player, tx, action)
        snapshots[name] = run.model_dump(mode="json", by_alias=True)

    capture("playing", "play")
    capture("paused", "pause")
    now[0] += timedelta(seconds=30)
    capture("pausedLater", "pause")
    capture("canalRising", "step")
    capture("accumulation3600", "step")
    capture("accumulation7200", "step")
    capture("rainLeaves", "step")
    capture("reset", "reset")
    # Stabilise only random epoch identities; retain every clock, cursor and state.
    identities = list(dict.fromkeys(run["id"] for run in snapshots.values()))
    for run in snapshots.values():
        run["id"] = f"40000000-0000-4000-8000-{identities.index(run['id']) + 1:012d}"
    return {"snapshots": snapshots, "signalCount": len(transport.messages)}


def test_web_rain_replay_matches_real_player() -> None:
    fixture = CATALOG.parents[1] / "apps/web/test/fixtures/bangkok-rain-replay.json"
    assert json.loads(fixture.read_text()) == rain_replay()


if __name__ == "__main__":
    print(json.dumps(rain_replay(), indent=2) + "\n", end="")
