from fastapi.testclient import TestClient
from fieldloop_simulator.main import app


def test_health_without_external_dependencies() -> None:
    with TestClient(app) as client:
        response = client.get("/healthz")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}


def test_scaffold_has_no_domain_routes() -> None:
    with TestClient(app) as client:
        assert client.post("/v1/action-requests", json={}).status_code == 404
