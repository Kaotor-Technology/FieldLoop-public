from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from fieldloop_simulator.main import app
from fieldloop_simulator.mock_cmms import SimulatedCmms


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
        # The clock is reported in UTC whatever offset the caller wrote it in.
        assert later.json()["asOf"] == "2026-10-11T00:00:00Z"


def test_reads_report_the_configured_organisation() -> None:
    original = app.state.cmms
    app.state.cmms = SimulatedCmms(org_id="other-org")
    try:
        with TestClient(app) as client:
            data = client.get("/mock/cmms/work-orders").json()
    finally:
        app.state.cmms = original
    assert {item["orgId"] for item in data["items"]} == {"other-org"}


def test_cmms_rejects_an_invalid_organisation_id() -> None:
    with pytest.raises(ValueError, match="Organisation"):
        SimulatedCmms(org_id="not valid")


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
        {"asOf": "1760000000"},
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


def test_responses_match_the_canonical_wire_schema() -> None:
    import json
    from pathlib import Path

    from jsonschema import Draft202012Validator, FormatChecker, ValidationError

    schema_path = (
        Path(__file__).resolve().parents[3] / "packages/contracts/mock-cmms.v1.schema.json"
    )
    validator = Draft202012Validator(
        json.loads(schema_path.read_text()), format_checker=FormatChecker()
    )
    with TestClient(app) as client:
        for params in ({}, {"pmDue": "true"}, {"pmDue": "true", "asOf": "2020-01-01T00:00:00Z"}):
            data = client.get("/mock/cmms/work-orders", params=params).json()
            validator.validate(data)
            for item in data["items"]:
                item["simulated"] = False
                with pytest.raises(ValidationError):
                    validator.validate(data)
                item["simulated"] = True


def test_generated_response_model_has_no_contract_drift(tmp_path: Path) -> None:
    import subprocess
    import sys
    from pathlib import Path

    root = Path(__file__).resolve().parents[3]
    output = tmp_path / "generated.py"
    subprocess.run(
        [sys.executable, str(root / "scripts/generate-mock-cmms.py"), "--output", str(output)],
        check=True,
    )
    assert (
        output.read_bytes()
        == (root / "py/fieldloop_common/src/fieldloop_common/generated_mock_cmms.py").read_bytes()
    )


def test_internal_openapi_contract_documents_only_read_operations() -> None:
    import json

    root = Path(__file__).resolve().parents[3]
    contract = json.loads((root / "packages/contracts/mock-cmms.v1.openapi.json").read_text())
    assert contract["openapi"] == "3.1.0"
    path = contract["paths"]["/mock/cmms/work-orders"]
    assert set(path) == {"get"}
    operation = path["get"]
    assert {p["name"] for p in operation["parameters"]} == {"pmDue", "asOf"}
    assert operation["responses"]["200"]["content"]["application/json"]["schema"] == {
        "$ref": "mock-cmms.v1.schema.json",
    }
    for status in ("400", "405"):
        assert operation["responses"][status]["content"]["application/problem+json"]["schema"] == {
            "$ref": "openapi.yaml#/components/schemas/Problem",
        }


@pytest.mark.parametrize(
    "timestamp",
    [
        "2026-10-10t00:00:00z",
        "2026-10-10T00:00:00z",
        "2026-10-10t00:00:00Z",
    ],
)
def test_rfc3339_lowercase_separators_match_the_uppercase_snapshot(timestamp: str) -> None:
    with TestClient(app) as client:
        expected = client.get(
            "/mock/cmms/work-orders",
            params={
                "pmDue": "true",
                "asOf": "2026-10-10T00:00:00Z",
            },
        )
        actual = client.get("/mock/cmms/work-orders", params={"pmDue": "true", "asOf": timestamp})
        assert actual.status_code == 200
        assert actual.json() == expected.json()
