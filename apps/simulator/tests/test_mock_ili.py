import asyncio
import json
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from fieldloop_common.signal import parse_signal
from fieldloop_common.signal_publisher import SignalPublisher
from fieldloop_simulator.main import app
from fieldloop_simulator.mock_ili import SimulatedIliDrop
from fieldloop_simulator.mock_signals import SimulatedSignalEmitter
from jsonschema import Draft202012Validator, FormatChecker, ValidationError

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = ROOT / "apps/simulator/src/fieldloop_simulator/fixtures/ili/SYN-ILI-2026-001.json"
REPORT = "SYN-ILI-2026-001"
URL = f"/mock/ili/reports/{REPORT}"
ROUTE_LENGTH_M = 180_000
AT = datetime(2026, 10, 12, 8, 0, tzinfo=UTC)


class RecordingTransport:
    def __init__(self) -> None:
        self.messages: list[tuple[str, bytes, dict[str, str]]] = []

    async def publish(self, topic: str, data: bytes, attributes: dict[str, str]) -> str:
        self.messages.append((topic, data, attributes))
        return "message-144"


def test_report_is_the_dropped_document_and_a_deterministic_synthetic_read() -> None:
    with TestClient(app) as client:
        first = client.get(URL)
        assert first.status_code == 200
        assert first.headers["content-type"].startswith("application/json")
        assert first.json() == client.get(URL).json()
    # One document is both the file in the bucket and the API response.
    assert first.json() == json.loads(FIXTURE.read_text())
    data = first.json()
    assert data["label"] == "SYNTHETIC"
    assert data["simulated"] is True
    assert data["classification"] == "HIGHLY_RESTRICTED"
    assert data["assetCode"] == "DL-01"
    assert "orgId" not in data


def test_anomalies_are_consistent_and_inside_the_inspected_run() -> None:
    data = json.loads(FIXTURE.read_text())
    anomalies = data["anomalies"]
    assert data["anomalyCount"] == len(anomalies) == 6
    assert data["inspectedFromChainageM"] == 0
    assert data["inspectedToChainageM"] == ROUTE_LENGTH_M
    chainages = [item["chainageM"] for item in anomalies]
    assert chainages == sorted(chainages)
    assert len({item["id"] for item in anomalies}) == len(anomalies)
    assert all(
        data["inspectedFromChainageM"] <= value <= data["inspectedToChainageM"]
        for value in chainages
    )
    assert (
        datetime.fromisoformat(data["runDate"]).date()
        < datetime.fromisoformat(data["issuedAt"]).date()
    )


def test_unknown_report_is_a_not_found_problem() -> None:
    with TestClient(app) as client:
        for report in ("SYN-ILI-2026-999", "nope", "SYN-ILI-2026-001.json"):
            response = client.get(f"/mock/ili/reports/{report}")
            assert response.status_code == 404
            assert response.headers["content-type"].startswith("application/problem+json")
            assert response.json()["code"] == "not_found"
            assert report not in response.text


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE", "TRACE", "CONNECT"])
def test_writes_are_rejected_without_mutating_the_report(method: str) -> None:
    with TestClient(app) as client:
        before = client.get(URL).json()
        rejected = client.request(method, URL, json={"anomalyCount": 0})
        assert rejected.status_code == 405
        assert rejected.headers["allow"] == "GET"
        assert rejected.headers["content-type"].startswith("application/problem+json")
        assert client.get(URL).json() == before


def test_the_report_matches_the_canonical_wire_schema() -> None:
    schema = json.loads((ROOT / "packages/contracts/mock-ili.v1.schema.json").read_text())
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    validator.validate(json.loads(FIXTURE.read_text()))
    with TestClient(app) as client:
        data = client.get(URL).json()
    validator.validate(data)
    for change in (
        {"simulated": False},
        {"classification": "INTERNAL"},
        {"anomalies": [{**data["anomalies"][0], "clockPosition": "13:00"}]},
        {"orgId": "fieldloop-demo"},
    ):
        with pytest.raises(ValidationError):
            validator.validate({**data, **change})


def test_arrival_is_announced_as_a_signal_that_points_at_the_dropped_file() -> None:
    drop = SimulatedIliDrop(bucket="example-fieldloop-dev-ili-drop")
    transport = RecordingTransport()
    publisher = SignalPublisher(
        transport, environment="dev", org_id="fieldloop-demo", simulation_only=True
    )
    emitter = SimulatedSignalEmitter(
        publisher, org_id="fieldloop-demo", source="mock-ili", classification="HIGHLY_RESTRICTED"
    )
    result = asyncio.run(emitter.emit(drop.observe(REPORT, AT)))
    assert result.outcome == "published"
    topic, data, attributes = transport.messages[0]
    assert topic == "signals"
    signal = json.loads(data)
    parse_signal(signal)
    assert signal["source"] == "mock-ili"
    assert signal["tag"] == "DL-01.ili.report.received"
    assert signal["value"] == 1
    assert signal["unit"] == "boolean"
    assert signal["observedAt"] == "2026-10-12T08:00:00Z"
    assert signal["classification"] == "HIGHLY_RESTRICTED"
    assert attributes["simulated"] == "true"
    assert signal["payload"] == {
        "assetCode": "DL-01",
        "reportId": REPORT,
        "bucket": "example-fieldloop-dev-ili-drop",
        "objectName": f"reports/{REPORT}.json",
        "contentType": "application/json",
        "anomalyCount": 6,
        "label": "SYNTHETIC",
    }
    # The payload locates the file; the findings themselves are not copied into the Signal.
    assert "anomalies" not in signal["payload"]


def test_the_announcement_omits_the_bucket_when_none_is_configured() -> None:
    payload = SimulatedIliDrop().observe(REPORT, AT).payload
    assert payload is not None
    assert "bucket" not in payload
    assert payload["objectName"] == f"reports/{REPORT}.json"


def test_unknown_reports_cannot_be_announced() -> None:
    with pytest.raises(KeyError):
        SimulatedIliDrop().observe("SYN-ILI-2026-999", AT)


@pytest.mark.parametrize("bucket", ["", "UPPER", "a", "has space", "-lead", "x" * 64])
def test_drop_rejects_an_invalid_bucket_name(bucket: str) -> None:
    with pytest.raises(ValueError, match="bucket"):
        SimulatedIliDrop(bucket=bucket)


def test_generated_response_model_has_no_contract_drift(tmp_path: Path) -> None:
    output = tmp_path / "generated.py"
    subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts/generate_mock_source.py"),
            "ili",
            "--output",
            str(output),
        ],
        check=True,
    )
    committed = ROOT / "py/fieldloop_common/src/fieldloop_common/generated_mock_ili.py"
    assert output.read_bytes() == committed.read_bytes()


def test_internal_openapi_contract_documents_only_read_operations() -> None:
    contract = json.loads((ROOT / "packages/contracts/mock-ili.v1.openapi.json").read_text())
    assert contract["openapi"] == "3.1.0"
    path = contract["paths"]["/mock/ili/reports/{id}"]
    assert set(path) == {"get"}
    operation = path["get"]
    assert {p["name"] for p in operation["parameters"]} == {"id"}
    assert operation["responses"]["200"]["content"]["application/json"]["schema"] == {
        "$ref": "mock-ili.v1.schema.json",
    }
    for status in ("404", "405"):
        assert operation["responses"][status]["content"]["application/problem+json"]["schema"] == {
            "$ref": "openapi.yaml#/components/schemas/Problem",
        }
