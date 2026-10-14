"""User-authorized merged-setting acceptance against the actual pinned catalog."""

import asyncio
import json
import math
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from fieldloop_common.generated_simulation import RunCreate
from fieldloop_simulator.scenario import ScenarioError, load_scenario, validate_scenario
from pydantic import ValidationError

from apps.simulator.tests.test_demo_scenarios import command, content, harness, signals
from apps.simulator.tests.test_player_http import client  # noqa: F401 - shared fixture

SNAP = Path(__file__).resolve().parents[3]
CATALOG = SNAP / "data/scenarios"


def losses(messages):
    return [
        s
        for s in messages
        if s["tag"] == "pump.power"
        and s["value"] == "lost"
        and s["payload"]["target"] == {"kind": "asset", "id": "P-3"}
    ]


@pytest.mark.parametrize("speed", [1, 60])
def test_actual_catalog_threshold_before_outage_at_7201(speed):
    scenario = load_scenario(CATALOG / "bangkok-storm.yaml")
    player, tx, transport, now = harness(scenario, speed=speed)
    anchor = now[0]
    start = datetime.fromisoformat(scenario.starts_at)
    command(player, tx, "play")
    rain = next(s for s in signals(transport) if s["tag"] == "rain.rate")
    assert (rain["value"], rain["unit"], rain["payload"]["zone"]) == (72, "mm/h", "Z3")
    for simulated_seconds in [7199, 7200, 7200.5, 7200.999, 7201]:
        # 1/60 second is not representable as datetime microseconds. Round UP;
        # the final 60x poll is 20 simulated microseconds after the boundary.
        wall_microseconds = math.ceil(simulated_seconds * 1_000_000 / speed)
        now[0] = anchor + timedelta(microseconds=wall_microseconds)
        asyncio.run(player.read(tx))
        emitted = signals(transport)
        lost = losses(emitted)
        accumulation = [s for s in emitted if s["tag"] == "rain.accumulation.24h"]
        if simulated_seconds < 7201:
            assert not lost
        else:
            assert len(lost) == 1
            assert lost[0]["observedAt"] == (start + timedelta(seconds=7201)).isoformat().replace(
                "+00:00", "Z"
            )
            assert lost[0]["source"] == "mock-pumps" and lost[0]["unit"] == "state"
        if simulated_seconds < 7200:
            assert max(s["value"] for s in accumulation) <= 100
        else:
            total = next(s for s in accumulation if s["value"] == 144)
            assert total["observedAt"] == (start + timedelta(seconds=7200)).isoformat().replace(
                "+00:00", "Z"
            )
            assert total["source"] == "mock-hydro" and total["unit"] == "mm"
            if lost:
                assert emitted.index(total) < emitted.index(lost[0])


@pytest.mark.parametrize("filename", ["cp-rectifier-failure.yaml", "bangkok-storm.yaml"])
def test_catalog_replay_reset_speed_order_and_provenance(filename):
    scenario = load_scenario(CATALOG / filename)
    runs = []
    for speed in [1, 60]:
        player, tx, transport, now = harness(scenario, seed=75, speed=speed)
        created_id = tx.snapshot.run.id
        command(player, tx, "play")
        now[0] += timedelta(
            microseconds=math.ceil((scenario.duration_seconds + 1) * 1_000_000 / speed)
        )
        assert asyncio.run(player.read(tx)).state == "finished"
        first = signals(transport)
        assert len(first) == len(scenario.events)
        for event, signal in zip(scenario.events, first, strict=True):
            assert signal["simulated"] is True
            assert signal["classification"] == scenario.classification
            assert signal["payload"]["sandbox"] is True
            assert signal["payload"]["label"] == "SIMULATION"
            assert signal["payload"]["target"] == event.target.model_dump()
            assert signal["simulationRunId"] == str(created_id)
            assert signal["observedAt"] == (
                datetime.fromisoformat(scenario.starts_at) + timedelta(seconds=event.at_seconds)
            ).isoformat().replace("+00:00", "Z")
        reset = command(player, tx, "reset")
        assert reset.id != created_id and reset.seed == 75 and reset.speed == speed
        command(player, tx, "bookmark", bookmarkId="complete")
        second = signals(transport)[len(first) :]
        assert tx.resets == 1 and content(first) == content(second)
        assert {s["id"] for s in first}.isdisjoint(s["id"] for s in second)
        assert all(s["simulationRunId"] == str(reset.id) for s in second)
        fresh_player, fresh_tx, fresh_transport, _ = harness(scenario, seed=75, speed=speed)
        command(fresh_player, fresh_tx, "bookmark", bookmarkId="complete")
        assert content(signals(fresh_transport)) == content(first)
        runs.append(content(first))
    assert runs[0] == runs[1]


@pytest.mark.parametrize("filename", ["cp-rectifier-failure.yaml", "bangkok-storm.yaml"])
def test_current_contract_seed_belongs_to_run_create_not_scenario(filename):
    import yaml
    from jsonschema import Draft202012Validator

    document = yaml.safe_load((CATALOG / filename).read_text())
    assert "seed" not in document
    scenario = load_scenario(CATALOG / filename)
    schema = json.loads((SNAP / "packages/contracts/simulation.v1.schema.json").read_text())[
        "$defs"
    ]["RunCreate"]
    missing = {"scenarioId": scenario.id, "speed": 1}
    assert not Draft202012Validator(schema).is_valid(missing)
    with pytest.raises(ValidationError, match="seed"):
        RunCreate.model_validate(missing)
    assert Draft202012Validator(schema).is_valid(dict(missing, seed=75))
    with pytest.raises(ScenarioError, match="additionalProperties"):
        validate_scenario(dict(document, seed=75))


@pytest.mark.parametrize("filename", ["cp-rectifier-failure.yaml", "bangkok-storm.yaml"])
def test_actual_catalog_missing_run_seed_is_http_400_without_state(client, filename):  # noqa: F811 - pytest fixture
    from fieldloop_simulator.main import app

    scenario = load_scenario(CATALOG / filename)
    app.state.simulation.player.catalog = {scenario.id: scenario}
    assert client.get("/v1/scenarios").json()[0]["id"] == scenario.id
    response = client.post(
        "/v1/simulation/runs",
        json={"scenarioId": scenario.id, "speed": 1},
        headers={"Idempotency-Key": "missing-seed-acceptance-01"},
    )
    assert response.status_code == 400
    assert response.headers["content-type"] == "application/problem+json"
    assert response.json()["code"] == "validation_failed"
    assert client.get("/v1/simulation/runs/current").json() is None
    # A valid seed with the SAME key succeeds: rejection did not reserve the key.
    corrected = client.post(
        "/v1/simulation/runs",
        json={"scenarioId": scenario.id, "speed": 1, "seed": 75},
        headers={"Idempotency-Key": "missing-seed-acceptance-01"},
    )
    assert corrected.status_code == 200
    assert corrected.json()["seed"] == 75
    assert corrected.json()["scenarioId"] == scenario.id
