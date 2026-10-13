from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from fieldloop_simulator.main import app
from fieldloop_simulator.mock_historian import DEMO_SEED
from fieldloop_simulator.player_service import SimulationService

from apps.simulator.tests.test_player import fixture


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    player, store, _, _ = fixture()
    monkeypatch.setenv("FIELDLOOP_ENV", "local")
    monkeypatch.setattr(
        app.state, "simulation", SimulationService(player, lambda: store, app.state.historian)
    )
    with TestClient(app, client=("127.0.0.1", 53000)) as connection:
        yield connection
    app.state.historian.reset()


def test_private_service_controls_and_reset_are_idempotent(client: TestClient) -> None:
    key = {"Idempotency-Key": "create-player-test-01"}
    assert client.get("/v1/simulation/runs/current").json() is None
    body = {"scenarioId": "player-test", "seed": 42, "speed": 1}
    created = client.post("/v1/simulation/runs", json=body, headers=key)
    assert created.status_code == 200
    run = created.json()
    assert client.post("/v1/simulation/runs", json=body, headers=key).json() == run
    body["seed"] = 41
    assert client.post("/v1/simulation/runs", json=body, headers=key).status_code == 409
    path = f"/v1/simulation/runs/{run['id']}"
    stepped = client.post(
        path + ":step", json={}, headers={"Idempotency-Key": "step-player-test-001"}
    )
    assert stepped.status_code == 200 and stepped.json()["nextEventIndex"] == 1
    reset_key = {"Idempotency-Key": "reset-player-test-01"}
    reset = client.post(path + ":reset", json={}, headers=reset_key)
    assert reset.status_code == 200 and reset.json()["id"] != run["id"]
    assert client.post(path + ":reset", json={}, headers=reset_key).json() == reset.json()
    assert client.get(path).status_code == 409
    assert client.get("/v1/simulation/runs/current").json()["nextEventIndex"] == 0


def test_no_active_run_restores_the_default_historian_seed(client: TestClient) -> None:
    app.state.historian.reset(seed=0)
    assert client.get("/v1/simulation/runs/current").json() is None
    assert app.state.historian.seed == DEMO_SEED


@pytest.mark.parametrize(
    "body",
    [
        {"scenarioId": "player-test", "seed": True, "speed": 1},
        {"scenarioId": "player-test", "seed": 42, "speed": "1"},
        {"scenarioId": "player-test", "seed": 42, "speed": 0},
        {"scenarioId": "player-test", "seed": 42, "speed": 1, "simulated": False},
    ],
)
def test_wire_validation_never_coerces_types(client: TestClient, body: dict) -> None:
    response = client.post(
        "/v1/simulation/runs", json=body, headers={"Idempotency-Key": "invalid-player-body"}
    )
    assert response.status_code == 400
    assert response.headers["content-type"] == "application/problem+json"
    assert client.get("/v1/simulation/runs/current").json() is None


def test_local_service_rejects_remote_callers_and_unknown_environment(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    with TestClient(app, client=("192.0.2.1", 53000)) as remote:
        assert remote.get("/v1/scenarios").status_code == 403
    monkeypatch.setenv("FIELDLOOP_ENV", "production")
    assert client.get("/v1/scenarios").status_code == 503


def test_missing_key_is_a_problem_response(client: TestClient) -> None:
    response = client.post(
        "/v1/simulation/runs", json={"scenarioId": "player-test", "seed": 42, "speed": 1}
    )
    assert response.status_code == 400
    assert response.headers["content-type"] == "application/problem+json"


def test_public_classification_cannot_downgrade_source_data(client: TestClient) -> None:
    assert client.get("/v1/scenarios").json()[0]["classification"] == "HIGHLY_RESTRICTED"
