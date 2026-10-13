import asyncio
import json
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from fieldloop_common.memory_transport import InMemoryTransport
from fieldloop_common.signal import parse_signal
from fieldloop_simulator.main import app
from fieldloop_simulator.mock_pumps import FACILITIES, Facility, SimulatedPumps
from fieldloop_simulator.mock_signals import SimulatedSignalEmitter
from jsonschema import Draft202012Validator, FormatChecker, ValidationError

ROOT = Path(__file__).resolve().parents[3]
BANGKOK = ROOT / "data/synthetic/bangkok"
SCHEMA = json.loads((ROOT / "packages/contracts/mock-pumps.v1.schema.json").read_text())
RUN = uuid.UUID("22222222-3333-4444-8555-666666666666")
POWER_LOST = datetime(2026, 10, 12, 6, 20, tzinfo=UTC)

# asset code -> (facility type, zone, operating state while it has power)
EXPECTED = {
    "P-1": ("pump", "Z3", "running"),
    "P-2": ("pump", "Z4", "running"),
    "P-3": ("pump", "Z3", "running"),
    "G-1": ("gate", "Z3", "closed"),
    "G-2": ("gate", "Z4", "closed"),
}


@pytest.fixture
def pumps() -> Iterator[SimulatedPumps]:
    source: SimulatedPumps = app.state.pumps
    source.reset()
    yield source
    source.reset()


def status(client: TestClient, asset_code: str, as_of: str | None = None) -> dict[str, object]:
    params = {} if as_of is None else {"asOf": as_of}
    response = client.get(f"/mock/pumps/{asset_code}/status", params=params)
    assert response.status_code == 200
    data: dict[str, object] = response.json()
    Draft202012Validator(SCHEMA, format_checker=FormatChecker()).validate(data)
    return data


@pytest.mark.parametrize("asset_code", EXPECTED)
def test_a_status_is_a_deterministic_labelled_simulated_read(asset_code: str) -> None:
    with TestClient(app) as client:
        data = status(client, asset_code)
        assert data == status(client, asset_code)
    facility_type, zone, operating_state = EXPECTED[asset_code]
    assert data == {
        "assetCode": asset_code,
        "facilityType": facility_type,
        "zoneCode": zone,
        "operatingState": operating_state,
        "powerStatus": "available",
        "observedAt": "2026-10-12T00:00:00Z",
        "orgId": "fieldloop-demo",
        "label": "SIMULATION",
        "simulated": True,
        "classification": "CONFIDENTIAL",
    }


@pytest.mark.parametrize("asset_code", ["P-9", "S-R1", "p-3", "x"])
def test_an_unknown_pump_or_gate_is_not_found(asset_code: str) -> None:
    with TestClient(app) as client:
        response = client.get(f"/mock/pumps/{asset_code}/status")
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["code"] == "not_found"


@pytest.mark.parametrize("as_of", ["2026-10-12T00:00:00", "1760227200", "tomorrow", ""])
def test_a_time_that_is_not_timezone_aware_rfc_3339_is_refused(as_of: str) -> None:
    with TestClient(app) as client:
        response = client.get("/mock/pumps/P-3/status", params={"asOf": as_of})
    assert response.status_code == 400
    assert response.json()["code"] == "validation_failed"


def test_reads_report_the_configured_organisation() -> None:
    previous = app.state.pumps
    app.state.pumps = SimulatedPumps(org_id="other-org")
    try:
        with TestClient(app) as client:
            assert status(client, "P-3")["orgId"] == "other-org"
    finally:
        app.state.pumps = previous


def test_a_pump_that_loses_power_stops_from_then_on_until_reset(pumps: SimulatedPumps) -> None:
    pumps.set_power("P-3", start=POWER_LOST, status="lost")
    with TestClient(app) as client:
        before = status(client, "P-3", "2026-10-12T06:19:59Z")
        during = status(client, "P-3", "2026-10-12T13:20:00+07:00")
        other = status(client, "P-1", "2026-10-12T06:20:00Z")
        pumps.reset()
        after_reset = status(client, "P-3", "2026-10-12T06:20:00Z")
    assert (before["powerStatus"], before["operatingState"]) == ("available", "running")
    assert (during["powerStatus"], during["operatingState"]) == ("lost", "stopped")
    assert during["observedAt"] == "2026-10-12T06:20:00Z"
    assert (other["powerStatus"], other["operatingState"]) == ("available", "running")
    assert (after_reset["powerStatus"], after_reset["operatingState"]) == ("available", "running")


def test_power_can_return_and_the_pump_runs_again(pumps: SimulatedPumps) -> None:
    pumps.set_power("P-3", start=POWER_LOST, status="lost")
    pumps.set_power("P-3", start=POWER_LOST + timedelta(hours=1), status="available")
    assert pumps.operating_state_at("P-3", POWER_LOST + timedelta(minutes=59)) == "stopped"
    assert pumps.operating_state_at("P-3", POWER_LOST + timedelta(hours=1)) == "running"


def test_a_gate_without_power_stays_where_it_was(pumps: SimulatedPumps) -> None:
    pumps.set_power("G-1", start=POWER_LOST, status="lost")
    with TestClient(app) as client:
        data = status(client, "G-1", "2026-10-12T06:20:00Z")
    assert (data["powerStatus"], data["operatingState"]) == ("lost", "closed")


def test_a_power_change_must_name_a_facility_a_timezone_and_a_status(
    pumps: SimulatedPumps,
) -> None:
    with pytest.raises(KeyError):
        pumps.set_power("P-9", start=POWER_LOST, status="lost")
    with pytest.raises(ValueError, match="timezone"):
        pumps.set_power("P-3", start=datetime(2026, 10, 12, 6, 20), status="lost")
    with pytest.raises(ValueError, match="available or lost"):
        pumps.set_power("P-3", start=POWER_LOST, status="off")  # type: ignore[arg-type]
    assert pumps.power_at("P-3", POWER_LOST) == "available"


def test_a_facility_cannot_be_authored_in_a_state_of_the_other_type() -> None:
    with pytest.raises(ValueError, match="pump cannot be open"):
        Facility("pump", "Z3", "open")
    with pytest.raises(ValueError, match="gate cannot be running"):
        Facility("gate", "Z3", "running")


def test_the_schema_refuses_a_state_that_does_not_fit_the_facility() -> None:
    with TestClient(app) as client:
        pump = status(client, "P-3")
        gate = status(client, "G-1")
    validator = Draft202012Validator(SCHEMA, format_checker=FormatChecker())
    with pytest.raises(ValidationError):
        validator.validate({**pump, "operatingState": "open"})
    with pytest.raises(ValidationError):
        validator.validate({**gate, "operatingState": "running"})


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
def test_a_write_commands_nothing(method: str) -> None:
    with TestClient(app) as client:
        before = status(client, "P-3")
        rejected = client.request(
            method, "/mock/pumps/P-3/status", json={"operatingState": "stopped"}
        )
        assert rejected.status_code == 405
        assert rejected.headers["allow"] == "GET"
        assert status(client, "P-3") == before


def test_power_lost_is_announced_as_a_validated_simulated_signal(
    pumps: SimulatedPumps, emitter: SimulatedSignalEmitter, transport: InMemoryTransport
) -> None:
    pumps.set_power("P-3", start=POWER_LOST, status="lost")
    outcome = asyncio.run(emitter.emit(pumps.observe("P-3", POWER_LOST), run_id=RUN))

    assert outcome.outcome == "published"
    ((topic, data, attributes),) = transport.messages
    signal = json.loads(data)
    parse_signal(signal)
    assert (topic, attributes["simulated"]) == ("signals", "true")
    assert {key: signal[key] for key in ("source", "tag", "value", "observedAt")} == {
        "source": "mock-pumps",
        "tag": "P-3.pump.power",
        "value": "lost",
        "observedAt": "2026-10-12T06:20:00Z",
    }
    assert "unit" not in signal
    assert (signal["simulated"], signal["classification"]) == (True, "CONFIDENTIAL")
    assert signal["simulationRunId"] == str(RUN)
    cases = json.loads((ROOT / "packages/contracts/test/fixtures/signal-cases.json").read_text())
    (example,) = [case["signal"] for case in cases if case["name"] == "pump power lost"]
    for member in ("source", "tag", "value", "classification", "simulated"):
        assert signal[member] == example[member], member
    assert signal["payload"] == {
        "assetCode": "P-3",
        "facilityType": "pump",
        "zoneCode": "Z3",
        "operatingState": "stopped",
        "label": "SIMULATION",
    }


def test_each_facility_has_its_own_tag_and_a_replay_keeps_the_signal_id(
    pumps: SimulatedPumps, emitter: SimulatedSignalEmitter
) -> None:
    signals = {code: emitter.build(pumps.observe(code, POWER_LOST), RUN) for code in EXPECTED}
    assert {code: signal["tag"] for code, signal in signals.items()} == {
        "P-1": "P-1.pump.power",
        "P-2": "P-2.pump.power",
        "P-3": "P-3.pump.power",
        "G-1": "G-1.gate.power",
        "G-2": "G-2.gate.power",
    }
    assert len({signal["id"] for signal in signals.values()}) == len(EXPECTED)
    assert signals["P-3"] == emitter.build(pumps.observe("P-3", POWER_LOST), RUN)
    # Losing power is a different value, so it is a different Signal at the same instant.
    pumps.set_power("P-3", start=POWER_LOST, status="lost")
    assert emitter.build(pumps.observe("P-3", POWER_LOST), RUN)["id"] != signals["P-3"]["id"]


def test_the_facilities_are_the_pumps_and_gates_of_the_bangkok_data() -> None:
    features = json.loads((BANGKOK / "facilities.geojson").read_text())["features"]
    authored = {
        feature["properties"]["asset_code"]: (
            feature["properties"]["facility_type"],
            feature["properties"]["zone_code"],
        )
        for feature in features
        if feature["properties"]["facility_type"] in ("pump", "gate")
    }
    assert authored == {
        code: (facility.facility_type, facility.zone_code) for code, facility in FACILITIES.items()
    }
