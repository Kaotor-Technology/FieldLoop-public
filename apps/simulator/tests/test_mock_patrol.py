import asyncio
import json
import math
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from fieldloop_common.signal import parse_signal
from fieldloop_common.signal_publisher import SignalPublisher
from fieldloop_simulator.main import app
from fieldloop_simulator.mock_patrol import SimulatedPatrol
from fieldloop_simulator.mock_signals import SimulatedSignalEmitter
from jsonschema import Draft202012Validator, FormatChecker, ValidationError

ROOT = Path(__file__).resolve().parents[3]
URL = "/mock/patrol/findings"
EARTH_RADIUS_M = 6_371_008.8

# id -> (kind, severity, status, observedAt, intended Chainage in metres on DL-01)
EXPECTED = {
    "SYN-PATROL-005": ("marker_damage", "low", "closed", "2026-10-09T08:00:00Z", 23_100),
    "SYN-PATROL-001": ("encroachment", "high", "open", "2026-10-11T02:15:00Z", 38_400),
    "SYN-PATROL-002": ("marker_damage", "low", "open", "2026-10-11T03:05:00Z", 61_700),
    "SYN-PATROL-003": ("erosion", "medium", "open", "2026-10-11T04:40:00Z", 104_900),
    "SYN-PATROL-004": ("encroachment", "medium", "open", "2026-10-11T06:20:00Z", 142_300),
}


def route() -> list[tuple[float, float, float]]:
    """DL-01 vertices as (longitude, latitude, cumulative Chainage in metres)."""
    path = ROOT / "data/synthetic/dl-01/route.geojson"
    coordinates = json.loads(path.read_text())["features"][0]["geometry"]["coordinates"]
    points = [(lon, lat, 0.0) for lon, lat in coordinates]
    for index in range(1, len(points)):
        (lon0, lat0, run), (lon1, lat1, _) = points[index - 1], points[index]
        dlat, dlon = math.radians(lat1 - lat0), math.radians(lon1 - lon0)
        h = (
            math.sin(dlat / 2) ** 2
            + math.cos(math.radians(lat0)) * math.cos(math.radians(lat1)) * math.sin(dlon / 2) ** 2
        )
        points[index] = (lon1, lat1, run + 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h)))
    return points


def snap(latitude: float, longitude: float) -> tuple[float, float]:
    """Distance from the route in metres and the Chainage of the nearest point on it."""
    best = (math.inf, 0.0)
    vertices = route()
    scale = math.radians(1) * EARTH_RADIUS_M
    for (lon0, lat0, c0), (lon1, lat1, c1) in zip(vertices, vertices[1:], strict=False):
        cos = math.cos(math.radians(latitude))
        ax, ay = (lon0 - longitude) * cos * scale, (lat0 - latitude) * scale
        bx, by = (lon1 - longitude) * cos * scale, (lat1 - latitude) * scale
        dx, dy = bx - ax, by - ay
        span = dx * dx + dy * dy
        # The generator can repeat a vertex where a control point lands on a sample point.
        t = max(0.0, min(1.0, -(ax * dx + ay * dy) / span)) if span else 0.0
        distance = math.hypot(ax + t * dx, ay + t * dy)
        if distance < best[0]:
            best = (distance, c0 + t * (c1 - c0))
    return best


def test_findings_are_a_deterministic_labelled_synthetic_read() -> None:
    with TestClient(app) as client:
        first = client.get(URL)
        assert first.status_code == 200
        assert first.json() == client.get(URL).json()
    data = first.json()
    assert data["label"] == "SYNTHETIC"
    assert data["simulated"] is True
    assert data["classification"] == "HIGHLY_RESTRICTED"
    assert data["total"] == len(data["items"]) == len(EXPECTED)
    # Oldest first; the identifier breaks ties.
    assert [item["id"] for item in data["items"]] == list(EXPECTED)
    for item in data["items"]:
        kind, severity, status, observed_at, _ = EXPECTED[item["id"]]
        assert (item["kind"], item["severity"], item["status"], item["observedAt"]) == (
            kind,
            severity,
            status,
            observed_at,
        )
        assert item["orgId"] == "fieldloop-demo"
        assert item["assetCode"] == "DL-01"
        assert item["label"] == "SYNTHETIC"
        assert item["simulated"] is True
        assert item["classification"] == "HIGHLY_RESTRICTED"
        assert item["summary"].startswith("Synthetic ")


def test_every_gps_fix_sits_inside_the_right_of_way_at_its_intended_chainage() -> None:
    with TestClient(app) as client:
        items = client.get(URL).json()["items"]
    for item in items:
        gps = item["gps"]
        offset, chainage = snap(gps["latitude"], gps["longitude"])
        intended = EXPECTED[item["id"]][4]
        assert offset <= 20, f"{item['id']} is {offset:.0f} m from the route"
        assert abs(chainage - intended) <= 50, f"{item['id']} snaps to {chainage:.0f} m"
        assert gps["accuracyM"] > 0


def test_kind_and_since_filter_the_list() -> None:
    with TestClient(app) as client:
        encroachments = client.get(URL, params={"kind": "encroachment"}).json()
        assert [item["id"] for item in encroachments["items"]] == [
            "SYN-PATROL-001",
            "SYN-PATROL-004",
        ]
        assert encroachments["total"] == 2
        recent = client.get(URL, params={"since": "2026-10-11T03:05:00Z"}).json()
        # since is inclusive: the finding observed exactly then is returned.
        assert [item["id"] for item in recent["items"]] == [
            "SYN-PATROL-002",
            "SYN-PATROL-003",
            "SYN-PATROL-004",
        ]
        combined = client.get(
            URL, params={"kind": "marker_damage", "since": "2026-10-10T00:00:00+07:00"}
        ).json()
        assert [item["id"] for item in combined["items"]] == ["SYN-PATROL-002"]
        assert client.get(URL, params={"since": "2027-01-01T00:00:00Z"}).json()["items"] == []


@pytest.mark.parametrize(
    "params",
    [
        {"kind": "leak"},
        {"kind": ""},
        {"since": "not-a-date"},
        {"since": "2026-10-11T03:00:00"},
        {"since": "2026-02-31T00:00:00Z"},
        {"since": "1760000000"},
        {"since": "0001-01-01T00:00:00+05:00"},
        {"since": "9999-12-31T23:59:59-05:00"},
    ],
)
def test_invalid_queries_fail_as_problem_json(params: dict[str, str]) -> None:
    with TestClient(app) as client:
        response = client.get(URL, params=params)
    assert response.status_code == 400
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["code"] == "validation_failed"
    for value in params.values():
        if value:
            assert value not in response.text


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE", "TRACE", "CONNECT"])
def test_writes_are_rejected_without_mutating_findings(method: str) -> None:
    with TestClient(app) as client:
        before = client.get(URL).json()
        rejected = client.request(method, URL, json={"status": "closed"})
        assert rejected.status_code == 405
        assert rejected.headers["allow"] == "GET"
        assert rejected.headers["content-type"].startswith("application/problem+json")
        assert client.get(URL).json() == before


def test_reads_report_the_configured_organisation() -> None:
    previous = app.state.patrol
    app.state.patrol = SimulatedPatrol(org_id="other-org")
    try:
        with TestClient(app) as client:
            orgs = {item["orgId"] for item in client.get(URL).json()["items"]}
    finally:
        app.state.patrol = previous
    assert orgs == {"other-org"}


class RecordingTransport:
    def __init__(self) -> None:
        self.messages: list[tuple[str, bytes, dict[str, str]]] = []

    async def publish(self, topic: str, data: bytes, attributes: dict[str, str]) -> str:
        self.messages.append((topic, data, attributes))
        return "message-143"


def emit(finding: str, at: datetime, run_id: object = None) -> dict[str, object]:
    transport = RecordingTransport()
    publisher = SignalPublisher(
        transport, environment="dev", org_id="fieldloop-demo", simulation_only=True
    )
    emitter = SimulatedSignalEmitter(
        publisher,
        org_id="fieldloop-demo",
        source="mock-patrol",
        classification="HIGHLY_RESTRICTED",
    )
    result = asyncio.run(emitter.emit(SimulatedPatrol().observe(finding, at), run_id=run_id))  # type: ignore[arg-type]
    assert result.outcome == "published"
    topic, data, attributes = transport.messages[0]
    assert topic == "signals"
    assert attributes["classification"] == "HIGHLY_RESTRICTED"
    assert attributes["simulated"] == "true"
    signal: dict[str, object] = json.loads(data)
    parse_signal(signal)
    return signal


AT = datetime(2026, 10, 12, 9, 0, tzinfo=UTC)


def test_an_open_encroachment_arrives_as_the_signal_the_pack_rule_matches() -> None:
    signal = emit("SYN-PATROL-001", AT)
    # The shape of FL-78's encroachment-detected rule: source, tag, eq 1, unit boolean.
    assert signal["source"] == "mock-patrol"
    assert signal["tag"] == "DL-01.encroachment.detected"
    assert signal["value"] == 1
    assert signal["unit"] == "boolean"
    assert signal["observedAt"] == "2026-10-12T09:00:00Z"
    assert signal["simulated"] is True
    assert signal["classification"] == "HIGHLY_RESTRICTED"
    payload = signal["payload"]
    assert isinstance(payload, dict)
    assert payload["findingId"] == "SYN-PATROL-001"
    assert payload["kind"] == "encroachment"
    assert payload["severity"] == "high"
    assert payload["status"] == "open"
    assert payload["foundAt"] == "2026-10-11T02:15:00Z"
    assert payload["label"] == "SYNTHETIC"
    assert set(payload["gps"]) == {"latitude", "longitude", "accuracyM"}  # type: ignore[call-overload]


def test_each_kind_has_its_own_detected_tag() -> None:
    tags = {
        finding: emit(finding, AT)["tag"]
        for finding in ("SYN-PATROL-001", "SYN-PATROL-002", "SYN-PATROL-003")
    }
    assert tags == {
        "SYN-PATROL-001": "DL-01.encroachment.detected",
        "SYN-PATROL-002": "DL-01.marker_damage.detected",
        "SYN-PATROL-003": "DL-01.erosion.detected",
    }


def test_a_closed_finding_clears_the_flag_instead_of_raising_it() -> None:
    signal = emit("SYN-PATROL-005", AT)
    assert signal["tag"] == "DL-01.marker_damage.detected"
    assert signal["value"] == 0
    payload = signal["payload"]
    assert isinstance(payload, dict) and payload["status"] == "closed"


def test_two_findings_of_one_kind_at_the_same_instant_keep_distinct_identities() -> None:
    first = emit("SYN-PATROL-001", AT)["id"]
    second = emit("SYN-PATROL-004", AT)["id"]
    assert first != second
    # A replay of the same finding keeps its identity (consumer deduplication).
    assert emit("SYN-PATROL-001", AT)["id"] == first


def test_an_unknown_finding_cannot_be_observed() -> None:
    with pytest.raises(KeyError):
        SimulatedPatrol().observe("SYN-PATROL-999", AT)
    with pytest.raises(ValueError, match="timezone"):
        SimulatedPatrol().observe("SYN-PATROL-001", datetime(2026, 10, 12, 9, 0))  # noqa: DTZ001


def test_patrol_rejects_an_invalid_organisation_id() -> None:
    with pytest.raises(ValueError, match="Organisation"):
        SimulatedPatrol(org_id="not valid")


def test_responses_match_the_canonical_wire_schema() -> None:
    schema = json.loads((ROOT / "packages/contracts/mock-patrol.v1.schema.json").read_text())
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    with TestClient(app) as client:
        for params in ({}, {"kind": "erosion"}, {"since": "2030-01-01T00:00:00Z"}):
            validator.validate(client.get(URL, params=params).json())
        data = client.get(URL).json()
    data["items"][0]["gps"]["latitude"] = 91
    with pytest.raises(ValidationError):
        validator.validate(data)
    data["items"][0]["gps"]["latitude"] = 18.2
    data["items"][0]["simulated"] = False
    with pytest.raises(ValidationError):
        validator.validate(data)


def test_generated_response_model_has_no_contract_drift(tmp_path: Path) -> None:
    output = tmp_path / "generated.py"
    subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts/generate-mock-source.py"),
            "patrol",
            "--output",
            str(output),
        ],
        check=True,
    )
    committed = ROOT / "py/fieldloop_common/src/fieldloop_common/generated_mock_patrol.py"
    assert output.read_bytes() == committed.read_bytes()


def test_internal_openapi_contract_documents_only_read_operations() -> None:
    contract = json.loads((ROOT / "packages/contracts/mock-patrol.v1.openapi.json").read_text())
    assert contract["openapi"] == "3.1.0"
    path = contract["paths"]["/mock/patrol/findings"]
    assert set(path) == {"get"}
    operation = path["get"]
    assert {p["name"] for p in operation["parameters"]} == {"kind", "since"}
    assert operation["responses"]["200"]["content"]["application/json"]["schema"] == {
        "$ref": "mock-patrol.v1.schema.json",
    }
    for status in ("400", "405"):
        assert operation["responses"][status]["content"]["application/problem+json"]["schema"] == {
            "$ref": "openapi.yaml#/components/schemas/Problem",
        }
