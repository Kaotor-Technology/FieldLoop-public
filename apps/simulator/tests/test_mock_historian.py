import json
import subprocess
import sys
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from fieldloop_simulator.main import app
from fieldloop_simulator.mock_historian import SimulatedHistorian
from jsonschema import Draft202012Validator, FormatChecker, ValidationError

ROOT = Path(__file__).resolve().parents[3]
RECTIFIER = "DL-01.rectifier.output"
WINDOW = {"from": "2026-10-12T00:00:00Z", "to": "2026-10-12T00:05:00Z"}


def series_url(tag: str = RECTIFIER) -> str:
    return f"/mock/historian/tags/{tag}"


@pytest.fixture
def historian() -> Iterator[SimulatedHistorian]:
    instance = app.state.historian
    instance.clear_overrides()
    yield instance
    instance.clear_overrides()


def test_series_is_a_deterministic_synthetic_read() -> None:
    with TestClient(app) as client:
        first = client.get(series_url(), params=WINDOW)
        assert first.status_code == 200
        assert first.json() == client.get(series_url(), params=WINDOW).json()
        data = first.json()
        assert data["tag"] == RECTIFIER
        assert data["unit"] == "A"
        assert data["source"] == "mock-historian"
        assert data["orgId"] == "fieldloop-demo"
        assert data["assetCode"] == "DL-01"
        assert data["label"] == "SYNTHETIC"
        assert data["simulated"] is True
        assert data["classification"] == "CONFIDENTIAL"
        assert data["from"] == "2026-10-12T00:00:00Z"
        assert data["to"] == "2026-10-12T00:05:00Z"
        assert data["intervalSeconds"] == 60
        assert data["total"] == len(data["points"]) == 6
        assert [point["t"] for point in data["points"]] == [
            f"2026-10-12T00:0{minute}:00Z" for minute in range(6)
        ]
        assert {point["quality"] for point in data["points"]} == {"good"}


@pytest.mark.parametrize(
    ("tag", "unit", "low", "high"),
    [
        ("DL-01.pressure.line", "bar", 55.0, 70.0),
        ("DL-01.flow.line", "m3/h", 1000.0, 1400.0),
        ("DL-01.rectifier.output", "A", 11.0, 13.0),
    ],
)
def test_each_demo_a_tag_reports_its_unit_inside_a_synthetic_band(
    tag: str, unit: str, low: float, high: float
) -> None:
    window = {"from": "2026-10-12T00:00:00Z", "to": "2026-10-13T00:00:00Z"}
    with TestClient(app) as client:
        data = client.get(series_url(tag), params=window).json()
    assert data["unit"] == unit
    assert data["total"] == 1441
    assert all(low <= point["v"] <= high for point in data["points"])
    assert len({point["v"] for point in data["points"]}) > 100


def test_offset_and_lowercase_timestamps_match_the_utc_snapshot() -> None:
    with TestClient(app) as client:
        expected = client.get(series_url(), params=WINDOW).json()
        for window in (
            {"from": "2026-10-12T07:00:00+07:00", "to": "2026-10-12T07:05:00+07:00"},
            {"from": "2026-10-12t00:00:00z", "to": "2026-10-12T00:05:00Z"},
        ):
            response = client.get(series_url(), params=window)
            assert response.status_code == 200
            assert response.json() == expected


def test_points_follow_the_clock_grid_not_the_requested_start() -> None:
    window = {"from": "2026-10-12T00:00:30Z", "to": "2026-10-12T00:03:30Z"}
    with TestClient(app) as client:
        data = client.get(series_url(), params=window).json()
    assert [point["t"] for point in data["points"]] == [
        "2026-10-12T00:01:00Z",
        "2026-10-12T00:02:00Z",
        "2026-10-12T00:03:00Z",
    ]


def test_unknown_tag_is_a_not_found_problem() -> None:
    with TestClient(app) as client:
        response = client.get(series_url("DL-01.unknown"), params=WINDOW)
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["code"] == "not_found"
    assert response.json()["status"] == 404


@pytest.mark.parametrize(
    "params",
    [
        {},
        {"from": "2026-10-12T00:00:00Z"},
        {"to": "2026-10-12T00:05:00Z"},
        {"from": "not-a-date", "to": "2026-10-12T00:05:00Z"},
        {"from": "2026-10-12T00:00:00", "to": "2026-10-12T00:05:00Z"},
        {"from": "2026-02-31T00:00:00Z", "to": "2026-10-12T00:05:00Z"},
        {"from": "1760000000", "to": "1760000300"},
        {"from": "2026-10-12T00:05:00Z", "to": "2026-10-12T00:00:00Z"},
        {"from": "2026-10-12T00:00:00Z", "to": "2026-10-12T00:00:00Z"},
        {"from": "2026-10-12T00:00:00Z", "to": "2026-10-13T00:00:01Z"},
    ],
)
def test_invalid_windows_fail_as_problem_json(params: dict[str, str]) -> None:
    with TestClient(app) as client:
        response = client.get(series_url(), params=params)
    assert response.status_code == 400
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["code"] == "validation_failed"
    assert response.json()["status"] == 400
    for value in params.values():
        assert value not in response.text


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE", "TRACE", "CONNECT"])
def test_writes_are_rejected_without_mutating_the_series(method: str) -> None:
    with TestClient(app) as client:
        before = client.get(series_url(), params=WINDOW).json()
        rejected = client.request(method, series_url(), json={"v": 0})
        assert rejected.status_code == 405
        assert rejected.headers["allow"] == "GET"
        assert rejected.headers["content-type"].startswith("application/problem+json")
        assert rejected.json()["status"] == 405
        assert client.get(series_url(), params=WINDOW).json() == before


def test_scenario_override_changes_reads_until_it_is_cleared(
    historian: SimulatedHistorian,
) -> None:
    historian.add_override(RECTIFIER, start=datetime(2026, 10, 12, 0, 2, tzinfo=UTC), value=0.0)
    with TestClient(app) as client:
        failed = {
            point["t"]: point["v"]
            for point in client.get(series_url(), params=WINDOW).json()["points"]
        }
        assert failed["2026-10-12T00:01:00Z"] > 0
        assert failed["2026-10-12T00:02:00Z"] == 0
        assert failed["2026-10-12T00:05:00Z"] == 0
        historian.clear_overrides()
        restored = client.get(series_url(), params=WINDOW).json()["points"]
    assert all(point["v"] > 0 for point in restored)


def test_override_resolution_prefers_the_latest_start_and_honours_its_end() -> None:
    historian = SimulatedHistorian(seed=1)
    base = historian.value_at(RECTIFIER, datetime(2026, 10, 12, 1, tzinfo=UTC))
    historian.add_override(RECTIFIER, start=datetime(2026, 10, 12, 0, tzinfo=UTC), value=5.0)
    historian.add_override(
        RECTIFIER,
        start=datetime(2026, 10, 12, 2, tzinfo=UTC),
        end=datetime(2026, 10, 12, 4, tzinfo=UTC),
        value=0.0,
    )
    assert historian.value_at(RECTIFIER, datetime(2026, 10, 11, 23, tzinfo=UTC)) != 5.0
    assert historian.value_at(RECTIFIER, datetime(2026, 10, 12, 1, tzinfo=UTC)) == 5.0
    assert historian.value_at(RECTIFIER, datetime(2026, 10, 12, 3, tzinfo=UTC)) == 0.0
    assert historian.value_at(RECTIFIER, datetime(2026, 10, 12, 4, tzinfo=UTC)) == 5.0
    assert base != 5.0
    with pytest.raises(KeyError):
        historian.add_override("DL-01.unknown", start=datetime(2026, 10, 12, tzinfo=UTC), value=1)
    with pytest.raises(ValueError, match="timezone"):
        historian.add_override(RECTIFIER, start=datetime(2026, 10, 12), value=1)  # noqa: DTZ001


def test_seed_selects_the_series_and_the_same_seed_reproduces_it() -> None:
    at = datetime(2026, 10, 12, 6, 30, tzinfo=UTC)
    first = SimulatedHistorian(seed=7).value_at(RECTIFIER, at)
    assert SimulatedHistorian(seed=7).value_at(RECTIFIER, at) == first
    assert SimulatedHistorian(seed=8).value_at(RECTIFIER, at) != first


def test_default_seed_reproduces_pinned_readings() -> None:
    # Pinned so that a change to the profile, hash or seed is a visible, reviewed change (SIM-5).
    historian = SimulatedHistorian()
    pinned = {
        ("DL-01.pressure.line", datetime(2026, 10, 12, 0, 0, tzinfo=UTC)): 63.552,
        ("DL-01.pressure.line", datetime(2026, 10, 12, 6, 0, tzinfo=UTC)): 61.9,
        ("DL-01.flow.line", datetime(2026, 10, 12, 0, 0, tzinfo=UTC)): 1264.947,
        ("DL-01.flow.line", datetime(2026, 10, 12, 12, 0, 30, tzinfo=UTC)): 1138.769,
        ("DL-01.rectifier.output", datetime(2026, 10, 12, 0, 0, tzinfo=UTC)): 12.383,
        ("DL-01.rectifier.output", datetime(2026, 10, 12, 12, 0, 30, tzinfo=UTC)): 11.607,
    }
    for (tag, at), expected in pinned.items():
        assert historian.value_at(tag, at) == expected


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_override_rejects_values_that_are_not_finite(value: float) -> None:
    with pytest.raises(ValueError, match="finite"):
        SimulatedHistorian().add_override(
            RECTIFIER, start=datetime(2026, 10, 12, tzinfo=UTC), value=value
        )


def test_override_must_end_after_it_starts() -> None:
    start = datetime(2026, 10, 12, tzinfo=UTC)
    with pytest.raises(ValueError, match="end after"):
        SimulatedHistorian().add_override(RECTIFIER, start=start, end=start, value=0.0)


@pytest.mark.parametrize("org_id", ["", "-bad", "has space", "line\nbreak", "x" * 129])
def test_historian_rejects_an_invalid_organisation_id(org_id: str) -> None:
    with pytest.raises(ValueError, match="Organisation"):
        SimulatedHistorian(org_id=org_id)


def test_reads_report_the_configured_organisation() -> None:
    previous = app.state.historian
    app.state.historian = SimulatedHistorian(org_id="other-org")
    try:
        with TestClient(app) as client:
            assert client.get(series_url(), params=WINDOW).json()["orgId"] == "other-org"
    finally:
        app.state.historian = previous


def test_responses_match_the_canonical_wire_schema() -> None:
    schema = json.loads((ROOT / "packages/contracts/mock-historian.v1.schema.json").read_text())
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    with TestClient(app) as client:
        for tag in ("DL-01.pressure.line", "DL-01.flow.line", RECTIFIER):
            data = client.get(series_url(tag), params=WINDOW).json()
            validator.validate(data)
            data["simulated"] = False
            with pytest.raises(ValidationError):
                validator.validate(data)


def test_generated_response_model_has_no_contract_drift(tmp_path: Path) -> None:
    output = tmp_path / "generated.py"
    subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts/generate-mock-source.py"),
            "historian",
            "--output",
            str(output),
        ],
        check=True,
    )
    committed = ROOT / "py/fieldloop_common/src/fieldloop_common/generated_mock_historian.py"
    assert output.read_bytes() == committed.read_bytes()


def test_internal_openapi_contract_documents_only_read_operations() -> None:
    contract = json.loads((ROOT / "packages/contracts/mock-historian.v1.openapi.json").read_text())
    assert contract["openapi"] == "3.1.0"
    path = contract["paths"]["/mock/historian/tags/{tag}"]
    assert set(path) == {"get"}
    operation = path["get"]
    assert {p["name"] for p in operation["parameters"]} == {"tag", "from", "to"}
    assert operation["responses"]["200"]["content"]["application/json"]["schema"] == {
        "$ref": "mock-historian.v1.schema.json",
    }
    for status in ("400", "404", "405"):
        assert operation["responses"][status]["content"]["application/problem+json"]["schema"] == {
            "$ref": "openapi.yaml#/components/schemas/Problem",
        }
