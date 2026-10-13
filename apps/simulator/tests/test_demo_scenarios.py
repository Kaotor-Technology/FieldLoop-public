"""Acceptance and replay checks for the authored FL-75 demo catalog; no cloud calls."""

import asyncio
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fieldloop_common.generated_scenario import Scenario
from fieldloop_common.generated_simulation import PlayerCommand, RunCreate
from fieldloop_common.memory_transport import InMemoryTransport
from fieldloop_common.signal_publisher import SignalPublisher
from fieldloop_simulator.mock_cmms import SimulatedCmms
from fieldloop_simulator.mock_patrol import SimulatedPatrol
from fieldloop_simulator.mock_signals import SimulatedSignalEmitter
from fieldloop_simulator.player import ScenarioPlayer
from fieldloop_simulator.scenario import load_scenario

from apps.simulator.tests.test_player import MemoryTransaction

ROOT = Path(__file__).resolve().parents[3]
CATALOG = ROOT / "data/scenarios"


def harness(scenario: Scenario, *, seed: int = 75, speed: float = 1):
    transport = InMemoryTransport()
    publisher = SignalPublisher(
        transport, environment="local", org_id="scenario-test", simulation_only=True
    )
    emitter = SimulatedSignalEmitter(publisher, org_id="scenario-test")
    now = [datetime(2026, 10, 13, tzinfo=UTC)]
    player = ScenarioPlayer(
        {scenario.id: scenario}, "scenario-test", lambda: emitter, lambda: now[0]
    )
    tx = MemoryTransaction()
    player.create(tx, RunCreate(scenarioId=scenario.id, seed=seed, speed=speed))
    return player, tx, transport, now


def command(player: ScenarioPlayer, tx: MemoryTransaction, name: str, **body: Any):
    assert tx.snapshot is not None
    return asyncio.run(
        player.command(tx, tx.snapshot.run.id, name, PlayerCommand.model_validate(body))
    )


def signals(transport: InMemoryTransport) -> list[dict[str, Any]]:
    assert all(topic == "signals" for topic, _, _ in transport.messages)
    return [json.loads(data) for _, data, _ in transport.messages]


def content(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # Reset intentionally opens a new epoch; preserve every other field in the comparison.
    return [
        {k: v for k, v in message.items() if k not in {"id", "simulationRunId"}}
        for message in messages
    ]


def test_demo_a_failure_ageing_and_encroachments_use_the_seed_and_sources() -> None:
    scenario = load_scenario(CATALOG / "cp-rectifier-failure.yaml")
    bowtie = json.loads((ROOT / "data/synthetic/dl-01/bowtie-a.json").read_text())
    cp = next(b for b in bowtie["barriers"] if b["id"] == "cathodic-protection")
    assert cp["health"] == "healthy" and cp["evidenceInterval"] == "12 months"
    latest = max(datetime.fromisoformat(e["observedAt"]) for e in cp["evidence"])
    due_at = latest.replace(year=latest.year + 1)
    start = datetime.fromisoformat(scenario.starts_at)
    assert start < due_at < start + timedelta(seconds=scenario.duration_seconds)

    player, tx, transport, _ = harness(scenario)
    command(player, tx, "bookmark", bookmarkId="complete")
    emitted = signals(transport)
    outputs = [s for s in emitted if s["tag"] == "DL-01.rectifier.output"]
    assert outputs[0]["value"] > 0
    assert all(s["value"] == 0 for s in outputs[1:])
    assert datetime.fromisoformat(outputs[-1]["observedAt"]) - datetime.fromisoformat(
        outputs[1]["observedAt"]
    ) > timedelta(hours=24)

    due = [s for s in emitted if s["source"] == "mock-cmms"]
    assert [s["value"] for s in due] == [0, 1]
    assert datetime.fromisoformat(due[1]["observedAt"]) == due_at + timedelta(seconds=1)
    cmms = SimulatedCmms(org_id="scenario-test")
    for signal in due:
        expected = cmms.observe("SYN-CMMS-001", datetime.fromisoformat(signal["observedAt"]))
        assert (signal["tag"], signal["unit"], signal["value"]) == (
            expected.tag,
            expected.unit,
            expected.value,
        )
        assert signal["payload"]["target"] == {"kind": "barrier", "id": cp["id"]}
        for key, value in expected.payload.items():
            if key != "label":
                assert signal["payload"][key] == value

    patrol = SimulatedPatrol(org_id="scenario-test")
    findings = [s for s in emitted if s["source"] == "mock-patrol"]
    assert {s["payload"]["findingId"] for s in findings} == {"SYN-PATROL-001", "SYN-PATROL-004"}
    assert len(findings) == 2
    for signal in findings:
        expected = patrol.observe(
            signal["payload"]["findingId"], datetime.fromisoformat(signal["observedAt"])
        )
        assert (signal["tag"], signal["unit"], signal["value"]) == (
            expected.tag,
            expected.unit,
            expected.value,
        )
        assert signal["payload"]["target"] == {"kind": "barrier", "id": "right-of-way-patrol"}
        for key, value in expected.payload.items():
            if key != "label":
                assert signal["payload"][key] == value


@pytest.mark.parametrize("filename", ["cp-rectifier-failure.yaml"])
def test_demo_replay_reset_speed_and_simulation_safety(filename: str) -> None:
    scenario = load_scenario(CATALOG / filename)
    player, tx, transport, now = harness(scenario)
    command(player, tx, "play")
    now[0] += timedelta(seconds=scenario.duration_seconds + 1)
    assert asyncio.run(player.read(tx)).state == "finished"
    first = signals(transport)
    assert len(first) == len(scenario.events)
    for event, signal in zip(scenario.events, first, strict=True):
        assert signal["simulated"] is True
        assert signal["classification"] == "HIGHLY_RESTRICTED"
        assert signal["payload"]["sandbox"] is True
        assert signal["payload"]["label"] == "SIMULATION"
        assert signal["payload"]["target"] == event.target.model_dump()
    assert len({s["id"] for s in first}) == len(first)

    command(player, tx, "reset")
    command(player, tx, "bookmark", bookmarkId="complete")
    second = signals(transport)[len(first) :]
    assert tx.resets == 1 and content(first) == content(second)
    assert {s["id"] for s in first}.isdisjoint(s["id"] for s in second)

    fast_player, fast_tx, fast_transport, fast_now = harness(scenario, speed=60)
    command(fast_player, fast_tx, "play")
    fast_now[0] += timedelta(seconds=(scenario.duration_seconds + 1) / 60)
    assert asyncio.run(fast_player.read(fast_tx)).state == "finished"
    assert content(signals(fast_transport)) == content(first)

    stepped_player, stepped_tx, stepped_transport, _ = harness(scenario)
    while stepped_tx.snapshot.run.state != "finished":
        command(stepped_player, stepped_tx, "step")
    assert content(signals(stepped_transport)) == content(first)


def test_seed_is_required_when_starting_an_authored_scenario() -> None:
    from pydantic import ValidationError

    with pytest.raises(ValidationError, match="seed"):
        RunCreate.model_validate({"scenarioId": "cp-rectifier-failure", "speed": 1})
