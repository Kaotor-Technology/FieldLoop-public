import asyncio
import json

from fastapi.testclient import TestClient
from fieldloop_common.signal import is_signal
from fieldloop_common.signal_publisher import SignalPublisher
from fieldloop_simulator.main import (
    app,
    publish_hydro_signal,
    publish_pump_signal,
)


class RecordingTransport:
    def __init__(self) -> None:
        self.messages: list[tuple[str, bytes, dict[str, str]]] = []

    async def publish(self, topic: str, data: bytes, attributes: dict[str, str]) -> str:
        self.messages.append((topic, data, attributes))
        return f"message-{len(self.messages)}"


def make_publisher(transport: RecordingTransport) -> SignalPublisher:
    return SignalPublisher(
        transport,
        environment="local",
        org_id="fieldloop-demo",
        simulation_only=True,
    )


def test_health_and_hydro_apis_return_simulated_observations() -> None:
    with TestClient(app) as client:
        assert client.get("/healthz").json() == {"status": "ok"}
        for kind, expected_unit, expected_value in (
            ("rain", "mm/h", 60.0),
            ("level", "m", 2.8),
            ("tide", "m", 1.4),
        ):
            response = client.get(f"/mock/hydro/{kind}?from=2026-10-12T00:00:00Z")
            assert response.status_code == 200
            observation = response.json()[0]
            assert observation["kind"] == kind
            assert observation["unit"] == expected_unit
            assert observation["value"] == expected_value
            assert observation["label"] == "SIMULATION"


def test_pump_status_includes_lost_power_and_gate_state() -> None:
    with TestClient(app) as client:
        response = client.get("/mock/pumps/P-3/status")
        assert response.status_code == 200
        assert response.json()["power_status"] == "lost"
        assert response.json()["pump_status"] == "stopped"
        assert response.json()["gate_status"] == "closed"
        assert response.json()["label"] == "SIMULATION"


def test_mock_source_api_rejects_write_methods() -> None:
    with TestClient(app) as client:
        for method in ("post", "put", "patch", "delete"):
            response = client.request(method.upper(), "/mock/hydro/rain", json={})
            assert response.status_code == 405
            assert response.headers["allow"] == "GET, HEAD, OPTIONS"


def test_hydro_publisher_sends_valid_simulated_signal_to_signals() -> None:
    transport = RecordingTransport()
    result = asyncio.run(publish_hydro_signal("rain", make_publisher(transport)))

    assert result == {"outcome": "published", "messageId": "message-1"}
    topic, data, attributes = transport.messages[0]
    signal = json.loads(data)
    assert topic == "signals"
    assert is_signal(signal)
    assert signal["simulated"] is True
    assert signal["source"] == "mock-hydro"
    assert signal["tag"] == "rain.rate"
    assert signal["unit"] == "mm/h"
    assert attributes["simulated"] == "true"


def test_pump_publisher_emits_power_lost_signal() -> None:
    transport = RecordingTransport()
    result = asyncio.run(publish_pump_signal("P-3", make_publisher(transport)))

    assert result["outcome"] == "published"
    topic, data, attributes = transport.messages[0]
    signal = json.loads(data)
    assert topic == "signals"
    assert is_signal(signal)
    assert signal["simulated"] is True
    assert signal["source"] == "mock-pumps"
    assert signal["tag"] == "pump.power"
    assert signal["value"] == "lost"
    assert attributes["simulated"] == "true"


def test_publish_signal_ids_are_stable_for_scenario_retry() -> None:
    transport = RecordingTransport()
    publisher = make_publisher(transport)
    asyncio.run(publish_hydro_signal("rain", publisher))
    asyncio.run(publish_hydro_signal("rain", publisher))

    first = json.loads(transport.messages[0][1])
    second = json.loads(transport.messages[1][1])
    assert first["id"] == second["id"]


def test_hydro_range_rejects_reversed_bounds() -> None:
    with TestClient(app) as client:
        response = client.get(
            "/mock/hydro/rain?from=2026-10-13T00:00:00Z&to=2026-10-12T00:00:00Z"
        )
        assert response.status_code == 422
