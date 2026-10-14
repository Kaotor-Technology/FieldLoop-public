"""Fixtures shared by the simulator tests."""

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from fieldloop_common.memory_transport import InMemoryTransport
from fieldloop_common.signal_publisher import SignalPublisher
from fieldloop_simulator.mock_signals import SimulatedSignalEmitter

ORG_ID = "fieldloop-demo"
ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture(autouse=True)
def seeded_asset_store(monkeypatch: pytest.MonkeyPatch) -> None:
    """Validate the app catalog against seeded Asset codes without a live database."""
    import fieldloop_simulator.main as simulator_main

    facilities = json.loads((ROOT / "data/synthetic/bangkok/facilities.geojson").read_text())
    asset_codes = {feature["properties"]["asset_code"] for feature in facilities["features"]}

    class SeededAssetStore:
        def asset_codes(self) -> set[str]:
            return set(asset_codes)

    store = SeededAssetStore()
    monkeypatch.setattr(simulator_main, "store", lambda: store)


@pytest.fixture
def transport() -> InMemoryTransport:
    return InMemoryTransport()


@pytest.fixture
def publisher(transport: InMemoryTransport) -> SignalPublisher:
    return SignalPublisher(transport, environment="dev", org_id=ORG_ID, simulation_only=True)


@pytest.fixture
def emitter(publisher: SignalPublisher) -> SimulatedSignalEmitter:
    return SimulatedSignalEmitter(publisher, org_id=ORG_ID)


@pytest.fixture
def signal_example() -> Callable[[str], dict[str, Any]]:
    """Look up an example Signal of the signal.v1 contract by the name of its case."""
    path = (
        Path(__file__).resolve().parents[3] / "packages/contracts/test/fixtures/signal-cases.json"
    )
    cases = json.loads(path.read_text())

    def find(name: str) -> dict[str, Any]:
        (signal,) = [case["signal"] for case in cases if case["name"] == name]
        return dict(signal)

    return find
