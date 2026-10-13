import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from fieldloop_common.memory_transport import InMemoryTransport
from fieldloop_common.signal import parse_signal
from fieldloop_simulator.main import app
from fieldloop_simulator.mock_cmms import SimulatedCmms
from fieldloop_simulator.mock_signals import SimulatedSignalEmitter
from jsonschema import Draft202012Validator, FormatChecker, ValidationError

ROOT = Path(__file__).resolve().parents[3]
URL = "/mock/cmms/work-orders"


def parse(timestamp: str) -> datetime:
    return datetime.fromisoformat(timestamp)


def test_work_orders_are_deterministic_synthetic_reads() -> None:
    with TestClient(app) as client:
        first = client.get(URL)
        assert first.status_code == 200
        assert first.json() == client.get(URL).json()
        data = first.json()
        assert data["label"] == "SYNTHETIC"
        assert data["simulated"] is True
        assert data["classification"] == "INTERNAL"
        assert data["asOf"] == "2026-10-12T00:00:00Z"
        assert data["total"] == len(data["items"]) == 4
        for item in data["items"]:
            assert item["simulated"] is True
            assert item["label"] == "SYNTHETIC"
            assert item["classification"] == "INTERNAL"
            assert item["orgId"] == "fieldloop-demo"
            assert item["assetCode"] == "DL-01"
            assert item["id"].startswith("SYN-CMMS-")


def test_only_a_completed_work_order_has_a_completion_time() -> None:
    with TestClient(app) as client:
        items = client.get(URL).json()["items"]
    assert {item["id"]: item.get("completedAt") for item in items} == {
        "SYN-CMMS-001": None,
        "SYN-CMMS-002": None,
        "SYN-CMMS-003": None,
        "SYN-CMMS-004": "2026-09-15T00:00:00Z",
    }
    # An open work order has no member at all; the contract does not allow a null.
    assert all("completedAt" in item for item in items if item["status"] == "completed")
    assert not any("completedAt" in item for item in items if item["status"] == "open")


def test_a_read_before_the_completion_time_shows_the_work_order_open() -> None:
    with TestClient(app) as client:
        before = client.get(URL, params={"asOf": "2026-09-14T23:59:59Z"}).json()["items"]
        at = client.get(URL, params={"asOf": "2026-09-15T00:00:00Z"}).json()["items"]
    survey = next(item for item in before if item["id"] == "SYN-CMMS-004")
    assert survey["status"] == "open"
    assert "completedAt" not in survey
    assert next(item for item in at if item["id"] == "SYN-CMMS-004")["status"] == "completed"


def pm_due(client: TestClient, as_of: str | None = None) -> list[str]:
    params = {"pmDue": "true"} | ({} if as_of is None else {"asOf": as_of})
    response = client.get(URL, params=params)
    assert response.status_code == 200
    assert response.json()["total"] == len(response.json()["items"])
    return [item["id"] for item in response.json()["items"]]


def test_pm_due_only_includes_open_preventive_orders_at_or_before_as_of() -> None:
    with TestClient(app) as client:
        # Nothing is due before the first due date; the completed survey never is.
        assert pm_due(client, "2026-09-15T00:00:00Z") == []
        assert pm_due(client, "2026-10-12T23:59:59Z") == []
        assert pm_due(client, "2026-10-13T00:00:00Z") == ["SYN-CMMS-001"]
        assert pm_due(client, "2027-09-14T23:59:59Z") == ["SYN-CMMS-001"]
        # The corrective repair is long past its due date here and is still left out.
        assert pm_due(client, "2027-09-15T00:00:00Z") == ["SYN-CMMS-001", "SYN-CMMS-002"]


def test_only_the_cathodic_protection_survey_falls_due_during_the_simulation() -> None:
    with TestClient(app) as client:
        # A bare read is the start of the simulation, when no preventive work is due.
        assert pm_due(client) == pm_due(client, "2026-10-12T00:00:00Z") == []
        # Through the demo on 18 October and beyond, the survey is the only change.
        assert pm_due(client, "2026-10-13T00:00:00Z") == ["SYN-CMMS-001"]
        assert pm_due(client, "2026-10-31T00:00:00Z") == ["SYN-CMMS-001"]
        # The same instant written with an offset; the clock is reported in UTC.
        assert pm_due(client, "2026-10-13T07:00:00+07:00") == ["SYN-CMMS-001"]
        offset = client.get(URL, params={"asOf": "2026-10-13T07:00:00+07:00"})
        assert offset.json()["asOf"] == "2026-10-13T00:00:00Z"


def a_year_after(timestamp: datetime) -> datetime:
    return timestamp.replace(year=timestamp.year + 1)


def test_the_fixtures_agree_with_the_dl_01_bowtie() -> None:
    # The simulator image does not carry data/, so the module holds literals; this keeps them true.
    bowtie = json.loads((ROOT / "data/synthetic/dl-01/bowtie-a.json").read_text())
    barriers = {barrier["id"]: barrier for barrier in bowtie["barriers"]}
    with TestClient(app) as client:
        data = client.get(URL).json()
    assert parse(data["asOf"]) == parse(bowtie["metadata"]["simulationStartsAt"])
    assert [(item["id"], item["barrierId"]) for item in data["items"]][0] == (
        "SYN-CMMS-001",
        "cathodic-protection",
    )
    preventive = [item for item in data["items"] if item["kind"] == "preventive"]
    assert len(preventive) == 3
    for item in data["items"]:
        assert item["barrierId"] in barriers
    for item in preventive:
        barrier = barriers[item["barrierId"]]
        assert barrier["evidenceInterval"] == "12 months"
        checks = sorted(parse(evidence["observedAt"]) for evidence in barrier["evidence"])
        if item["status"] == "open":
            # Due when the Barrier's newest Evidence is one evidence interval old.
            assert parse(item["dueAt"]) == a_year_after(checks[-1])
        else:
            # The completed work is the newest Evidence; it was due a year after the one before.
            assert parse(item["completedAt"]) == checks[-1]
            assert parse(item["dueAt"]) == a_year_after(checks[-2])


def test_reads_report_the_configured_organisation() -> None:
    original = app.state.cmms
    app.state.cmms = SimulatedCmms(org_id="other-org")
    try:
        with TestClient(app) as client:
            data = client.get(URL).json()
    finally:
        app.state.cmms = original
    assert {item["orgId"] for item in data["items"]} == {"other-org"}


def test_cmms_rejects_an_invalid_organisation_id() -> None:
    with pytest.raises(ValueError, match="Organisation"):
        SimulatedCmms(org_id="not valid")


def test_the_organisation_of_the_cmms_cannot_be_replaced() -> None:
    # A page copies the Organisation into each work order without validating it again.
    with pytest.raises(AttributeError):
        SimulatedCmms().org_id = "not valid!"


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE", "TRACE", "CONNECT"])
def test_mock_cmms_rejects_writes_without_mutating_fixtures(method: str) -> None:
    with TestClient(app) as client:
        before = client.get(URL).json()
        rejected = client.request(method, URL, json={"status": "completed"})
        assert rejected.status_code == 405
        assert rejected.headers["allow"] == "GET"
        assert rejected.headers["content-type"].startswith("application/problem+json")
        assert rejected.json()["code"] == "method_not_allowed"
        assert client.get(URL).json() == before


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
        result = client.get(URL, params=params)
        assert result.status_code == 400
        assert result.headers["content-type"].startswith("application/problem+json")
        assert result.json()["code"] == "validation_failed"
        assert result.json()["status"] == 400


def test_responses_match_the_canonical_wire_schema() -> None:
    validator = Draft202012Validator(
        json.loads((ROOT / "packages/contracts/mock-cmms.v1.schema.json").read_text()),
        format_checker=FormatChecker(),
    )
    with TestClient(app) as client:
        for params in ({}, {"pmDue": "true"}, {"pmDue": "true", "asOf": "2020-01-01T00:00:00Z"}):
            data = client.get(URL, params=params).json()
            validator.validate(data)
            for item in data["items"]:
                item["simulated"] = False
                with pytest.raises(ValidationError):
                    validator.validate(data)
                item["simulated"] = True


def test_the_schema_ties_the_completion_time_to_the_status() -> None:
    validator = Draft202012Validator(
        json.loads((ROOT / "packages/contracts/mock-cmms.v1.schema.json").read_text()),
        format_checker=FormatChecker(),
    )
    with TestClient(app) as client:
        data = client.get(URL).json()
    by_id = {item["id"]: item for item in data["items"]}
    del by_id["SYN-CMMS-004"]["completedAt"]
    with pytest.raises(ValidationError):
        validator.validate(data)
    by_id["SYN-CMMS-004"]["completedAt"] = "2026-09-15T00:00:00Z"
    validator.validate(data)
    by_id["SYN-CMMS-001"]["completedAt"] = "2026-09-15T00:00:00Z"
    with pytest.raises(ValidationError):
        validator.validate(data)


def test_the_contract_documents_both_query_parameters() -> None:
    # Paths, the schema reference and the 405 are checked for every source in test_mock_contracts.
    contract = json.loads((ROOT / "packages/contracts/mock-cmms.v1.openapi.json").read_text())
    operation = contract["paths"][URL]["get"]
    assert {parameter["name"] for parameter in operation["parameters"]} == {"pmDue", "asOf"}


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
            URL,
            params={
                "pmDue": "true",
                "asOf": "2026-10-10T00:00:00Z",
            },
        )
        actual = client.get(URL, params={"pmDue": "true", "asOf": timestamp})
        assert actual.status_code == 200
        assert actual.json() == expected.json()


def emit(
    emitter: SimulatedSignalEmitter,
    transport: InMemoryTransport,
    work_order: str,
    at: datetime,
) -> dict[str, object]:
    result = asyncio.run(emitter.emit(SimulatedCmms().observe(work_order, at)))
    assert result.outcome == "published"
    topic, data, attributes = transport.messages[-1]
    assert topic == "signals"
    assert attributes["classification"] == "INTERNAL"
    assert attributes["simulated"] == "true"
    signal: dict[str, object] = json.loads(data)
    parse_signal(signal)
    return signal


SURVEY_DUE = datetime(2026, 10, 13, tzinfo=UTC)


def test_a_work_order_past_its_due_date_arrives_as_an_overdue_signal(
    emitter: SimulatedSignalEmitter, transport: InMemoryTransport
) -> None:
    signal = emit(emitter, transport, "SYN-CMMS-001", SURVEY_DUE)
    assert signal["source"] == "mock-cmms"
    assert signal["tag"] == "DL-01.cathodic-protection.work_order.overdue"
    assert signal["value"] == 1
    assert signal["unit"] == "boolean"
    assert signal["observedAt"] == "2026-10-13T00:00:00Z"
    assert signal["simulated"] is True
    assert signal["classification"] == "INTERNAL"
    assert signal["payload"] == {
        "assetCode": "DL-01",
        "workOrderId": "SYN-CMMS-001",
        "barrierId": "cathodic-protection",
        "kind": "preventive",
        "status": "open",
        "title": "Synthetic cathodic protection survey",
        "dueAt": "2026-10-13T00:00:00Z",
        "label": "SYNTHETIC",
    }


def test_the_overdue_flag_follows_the_due_date_and_the_status(
    emitter: SimulatedSignalEmitter, transport: InMemoryTransport
) -> None:
    before = emit(emitter, transport, "SYN-CMMS-001", datetime(2026, 10, 12, 23, 59, tzinfo=UTC))
    assert before["value"] == 0
    # A corrective work order is announced the same way; its kind is in the payload.
    corrective = emit(emitter, transport, "SYN-CMMS-003", datetime(2026, 12, 15, tzinfo=UTC))
    assert corrective["tag"] == "DL-01.coating.work_order.overdue"
    assert corrective["value"] == 1
    assert isinstance(corrective["payload"], dict)
    assert corrective["payload"]["kind"] == "corrective"
    # Completed work is never overdue, however late it is observed.
    completed = emit(emitter, transport, "SYN-CMMS-004", datetime(2026, 12, 1, tzinfo=UTC))
    assert completed["value"] == 0
    assert isinstance(completed["payload"], dict)
    assert completed["payload"]["completedAt"] == "2026-09-15T00:00:00Z"
    # Observed before its completion time, the same work order is still open and not yet due.
    earlier = emit(emitter, transport, "SYN-CMMS-004", datetime(2026, 9, 14, tzinfo=UTC))
    assert earlier["value"] == 0
    assert isinstance(earlier["payload"], dict)
    assert earlier["payload"]["status"] == "open"
    assert "completedAt" not in earlier["payload"]


def test_each_barrier_has_its_own_tag_and_a_replay_keeps_its_signal_id(
    emitter: SimulatedSignalEmitter, transport: InMemoryTransport
) -> None:
    at = datetime(2027, 9, 15, tzinfo=UTC)
    first = emit(emitter, transport, "SYN-CMMS-001", at)
    second = emit(emitter, transport, "SYN-CMMS-002", at)
    # Both are overdue here; a rule tells them apart by tag, without reading the payload.
    assert first["value"] == second["value"] == 1
    assert second["tag"] == "DL-01.remote-automatic-valve-closure.work_order.overdue"
    assert first["tag"] != second["tag"]
    assert first["id"] != second["id"]
    assert emit(emitter, transport, "SYN-CMMS-001", at)["id"] == first["id"]


def test_an_unknown_work_order_cannot_be_observed() -> None:
    with pytest.raises(KeyError):
        SimulatedCmms().observe("SYN-CMMS-999", SURVEY_DUE)
    with pytest.raises(ValueError, match="timezone"):
        SimulatedCmms().observe("SYN-CMMS-001", datetime(2026, 10, 13))  # noqa: DTZ001
