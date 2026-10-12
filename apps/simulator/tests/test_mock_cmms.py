import pytest
from fastapi.testclient import TestClient
from fieldloop_simulator.main import app


def test_work_orders_are_deterministic_synthetic_reads() -> None:
    with TestClient(app) as client:
        first = client.get("/mock/cmms/work-orders")
        assert first.status_code == 200
        assert first.json() == client.get("/mock/cmms/work-orders").json()
        data = first.json()
        assert data["label"] == "SYNTHETIC"
        assert data["simulated"] is True
        assert data["classification"] == "INTERNAL"
        assert data["asOf"] == "2026-10-10T00:00:00Z"
        assert data["total"] == len(data["items"]) == 4
        for item in data["items"]:
            assert item["simulated"] is True
            assert item["label"] == "SYNTHETIC"
            assert item["classification"] == "INTERNAL"
            assert item["orgId"] == "fieldloop-demo"
            assert item["assetCode"] == "DL-01"
            assert item["id"].startswith("SYN-CMMS-")


def test_pm_due_only_includes_open_preventive_orders_at_or_before_as_of() -> None:
    with TestClient(app) as client:
        response = client.get("/mock/cmms/work-orders", params={"pmDue": "true"})
        assert response.status_code == 200
        assert [item["id"] for item in response.json()["items"]] == [
            "SYN-CMMS-001",
            "SYN-CMMS-002",
        ]
        earlier = client.get(
            "/mock/cmms/work-orders",
            params={
                "pmDue": "true",
                "asOf": "2026-10-08T23:59:59Z",
            },
        )
        assert earlier.status_code == 200
        assert earlier.json()["items"] == []
        assert earlier.json()["total"] == 0
        later = client.get(
            "/mock/cmms/work-orders",
            params={
                "pmDue": "true",
                "asOf": "2026-10-11T07:00:00+07:00",
            },
        )
        assert later.status_code == 200
        assert [item["id"] for item in later.json()["items"]] == [
            "SYN-CMMS-001",
            "SYN-CMMS-002",
        ]


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE", "TRACE", "CONNECT"])
def test_mock_cmms_rejects_writes_without_mutating_fixtures(method: str) -> None:
    with TestClient(app) as client:
        before = client.get("/mock/cmms/work-orders").json()
        rejected = client.request(method, "/mock/cmms/work-orders", json={"status": "completed"})
        assert rejected.status_code == 405
        assert rejected.headers["allow"] == "GET"
        assert rejected.headers["content-type"].startswith("application/problem+json")
        assert rejected.json()["status"] == 405
        assert client.get("/mock/cmms/work-orders").json() == before


@pytest.mark.parametrize(
    "params",
    [
        {"asOf": "not-a-date"},
        {"asOf": "2026-10-10T00:00:00"},
        {"asOf": "2026-02-31T00:00:00Z"},
        {"pmDue": "invalid"},
    ],
)
def test_invalid_queries_fail_as_problem_json(params: dict[str, str]) -> None:
    with TestClient(app) as client:
        result = client.get("/mock/cmms/work-orders", params=params)
        assert result.status_code == 400
        assert result.headers["content-type"].startswith("application/problem+json")
        assert result.json()["code"] == "validation_failed"
        assert result.json()["status"] == 400
