import asyncio
import json
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from fieldloop_common.memory_transport import InMemoryTransport
from fieldloop_common.signal import parse_signal
from fieldloop_simulator.main import app
from fieldloop_simulator.mock_hydro import SENSOR_PROFILES, SimulatedHydro
from fieldloop_simulator.mock_signals import SimulatedSignalEmitter
from jsonschema import Draft202012Validator, FormatChecker, ValidationError

ROOT = Path(__file__).resolve().parents[3]
BANGKOK = ROOT / "data/synthetic/bangkok"
SCHEMA = json.loads((ROOT / "packages/contracts/mock-hydro.v1.schema.json").read_text())
RUN = uuid.UUID("22222222-3333-4444-8555-666666666666")
STORM = datetime(2026, 10, 12, 6, 0, tzinfo=UTC)

# kind -> (sensor, zone, unit, value at the start of the simulation)
EXPECTED = {
    "rain": ("S-R1", "Z3", "mm/h", 0.0),
    "level": ("S-L1", "Z3", "m", 0.6),
    "tide": ("S-T1", "Z4", "m", 1.5),
}


def signal_example(name: str) -> dict[str, Any]:
    """An example Signal of the signal.v1 contract, which a Signal rule may be written from."""
    cases = json.loads((ROOT / "packages/contracts/test/fixtures/signal-cases.json").read_text())
    (signal,) = [case["signal"] for case in cases if case["name"] == name]
    return dict(signal)


@pytest.fixture
def hydro() -> Iterator[SimulatedHydro]:
    source: SimulatedHydro = app.state.hydro
    source.reset()
    yield source
    source.reset()


@pytest.mark.parametrize("kind", EXPECTED)
def test_a_reading_is_a_deterministic_labelled_simulated_read(kind: str) -> None:
    with TestClient(app) as client:
        first = client.get(f"/mock/hydro/{kind}")
        assert first.status_code == 200
        assert first.json() == client.get(f"/mock/hydro/{kind}").json()
    data = first.json()
    Draft202012Validator(SCHEMA, format_checker=FormatChecker()).validate(data)
    sensor, zone, unit, value = EXPECTED[kind]
    assert data == {
        "kind": kind,
        "assetCode": sensor,
        "zoneCode": zone,
        "value": value,
        "unit": unit,
        "observedAt": "2026-10-12T00:00:00Z",
        "orgId": "fieldloop-demo",
        "label": "SIMULATION",
        "simulated": True,
        "classification": "CONFIDENTIAL",
    }


def test_the_tide_moves_with_scenario_time_and_the_rest_hold_their_baseline() -> None:
    with TestClient(app) as client:
        readings = {
            kind: [
                client.get(f"/mock/hydro/{kind}", params={"asOf": at}).json()["value"]
                for at in ("2026-10-12T00:00:00Z", "2026-10-12T03:00:00Z", "2026-10-12T06:00:00Z")
            ]
            for kind in EXPECTED
        }
    assert readings == {"rain": [0.0, 0.0, 0.0], "level": [0.6, 0.6, 0.6], "tide": [1.5, 0.9, 0.3]}


def test_as_of_is_reported_in_utc() -> None:
    with TestClient(app) as client:
        data = client.get("/mock/hydro/rain", params={"asOf": "2026-10-12T13:00:00+07:00"}).json()
    assert data["observedAt"] == "2026-10-12T06:00:00Z"


def test_an_unknown_kind_is_not_found() -> None:
    with TestClient(app) as client:
        response = client.get("/mock/hydro/snow")
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["code"] == "not_found"


@pytest.mark.parametrize("as_of", ["2026-10-12T00:00:00", "1760227200", "tomorrow", ""])
def test_a_time_that_is_not_timezone_aware_rfc_3339_is_refused(as_of: str) -> None:
    with TestClient(app) as client:
        response = client.get("/mock/hydro/rain", params={"asOf": as_of})
    assert response.status_code == 400
    assert response.json()["code"] == "validation_failed"
    assert as_of == "" or as_of not in response.text


def test_reads_report_the_configured_organisation() -> None:
    previous = app.state.hydro
    app.state.hydro = SimulatedHydro(org_id="other-org")
    try:
        with TestClient(app) as client:
            assert client.get("/mock/hydro/rain").json()["orgId"] == "other-org"
    finally:
        app.state.hydro = previous


def test_an_override_holds_from_its_start_until_reset(hydro: SimulatedHydro) -> None:
    hydro.add_override("rain", start=STORM, value=60)
    with TestClient(app) as client:
        before = client.get("/mock/hydro/rain", params={"asOf": "2026-10-12T05:59:59Z"}).json()
        during = client.get("/mock/hydro/rain", params={"asOf": "2026-10-12T06:00:00Z"}).json()
        later = client.get("/mock/hydro/rain", params={"asOf": "2026-10-13T00:00:00Z"}).json()
        untouched = client.get("/mock/hydro/level", params={"asOf": "2026-10-12T06:00:00Z"}).json()
        hydro.reset()
        after_reset = client.get("/mock/hydro/rain", params={"asOf": "2026-10-12T06:00:00Z"}).json()
    assert (before["value"], during["value"], later["value"]) == (0.0, 60.0, 60.0)
    assert untouched["value"] == 0.6
    assert after_reset["value"] == 0.0


def test_the_latest_start_wins_and_among_equal_starts_the_last_added(
    hydro: SimulatedHydro,
) -> None:
    hydro.add_override("level", start=STORM + timedelta(hours=1), value=1.9)
    hydro.add_override("level", start=STORM, value=1.2)
    hydro.add_override("level", start=STORM, value=1.4)
    assert hydro.value_at("level", STORM) == 1.4
    assert hydro.value_at("level", STORM + timedelta(hours=2)) == 1.9


def test_an_override_must_name_a_kind_a_timezone_and_a_finite_value(
    hydro: SimulatedHydro,
) -> None:
    with pytest.raises(KeyError):
        hydro.add_override("snow", start=STORM, value=1.0)
    with pytest.raises(ValueError, match="timezone"):
        hydro.add_override("rain", start=datetime(2026, 10, 12, 6, 0), value=1.0)
    with pytest.raises(ValueError, match="finite"):
        hydro.add_override("rain", start=STORM, value=float("nan"))
    with pytest.raises(ValueError, match="below"):
        hydro.add_override("rain", start=STORM, value=-0.1)
    assert hydro.value_at("rain", STORM) == 0.0


def test_a_level_may_fall_below_its_datum_but_rain_starts_at_zero(hydro: SimulatedHydro) -> None:
    hydro.add_override("rain", start=STORM, value=0)
    hydro.add_override("tide", start=STORM, value=-0.2)
    assert (hydro.value_at("rain", STORM), hydro.value_at("tide", STORM)) == (0.0, -0.2)


def test_the_schema_refuses_a_unit_that_does_not_fit_the_kind() -> None:
    with TestClient(app) as client:
        rain = client.get("/mock/hydro/rain").json()
        tide = client.get("/mock/hydro/tide").json()
    validator = Draft202012Validator(SCHEMA, format_checker=FormatChecker())
    with pytest.raises(ValidationError):
        validator.validate({**rain, "unit": "m"})
    with pytest.raises(ValidationError):
        validator.validate({**tide, "unit": "mm/h"})


def test_a_write_changes_no_reading() -> None:
    with TestClient(app) as client:
        before = client.get("/mock/hydro/rain").json()
        rejected = client.post("/mock/hydro/rain", json={"value": 60})
        assert rejected.status_code == 405
        assert client.get("/mock/hydro/rain").json() == before


def test_the_storm_is_announced_as_a_validated_simulated_signal(
    hydro: SimulatedHydro, emitter: SimulatedSignalEmitter, transport: InMemoryTransport
) -> None:
    hydro.add_override("rain", start=STORM, value=60)
    outcome = asyncio.run(emitter.emit(hydro.observe("rain", STORM), run_id=RUN))

    assert outcome.outcome == "published"
    ((topic, data, attributes),) = transport.messages
    signal = json.loads(data)
    parse_signal(signal)
    assert (topic, attributes["simulated"]) == ("signals", "true")
    assert {key: signal[key] for key in ("source", "tag", "value", "unit", "observedAt")} == {
        "source": "mock-hydro",
        "tag": "S-R1.rain.rate",
        "value": 60,
        "unit": "mm/h",
        "observedAt": "2026-10-12T06:00:00Z",
    }
    assert (signal["simulated"], signal["classification"]) == (True, "CONFIDENTIAL")
    assert signal["simulationRunId"] == str(RUN)
    example = signal_example("flood observation")
    for member in ("source", "tag", "value", "unit", "classification", "simulated"):
        assert signal[member] == example[member], member
    assert signal["payload"].items() <= example["payload"].items()
    assert signal["payload"] == {
        "assetCode": "S-R1",
        "zoneCode": "Z3",
        "kind": "rain",
        "label": "SIMULATION",
    }


@pytest.mark.parametrize(
    ("kind", "tag"),
    [("rain", "S-R1.rain.rate"), ("level", "S-L1.water.level"), ("tide", "S-T1.tide.level")],
)
def test_each_kind_has_its_own_tag_and_a_replay_keeps_the_signal_id(
    kind: str, tag: str, hydro: SimulatedHydro, emitter: SimulatedSignalEmitter
) -> None:
    first = emitter.build(hydro.observe(kind, STORM), RUN)
    assert first["tag"] == tag
    assert first == emitter.build(hydro.observe(kind, STORM), RUN)
    assert (
        first["id"] != emitter.build(hydro.observe(kind, STORM + timedelta(minutes=1)), RUN)["id"]
    )


def test_the_sensors_are_the_sensor_facilities_of_the_bangkok_data() -> None:
    features = json.loads((BANGKOK / "facilities.geojson").read_text())["features"]
    authored = {
        feature["properties"]["facility_type"].removesuffix("_sensor"): (
            feature["properties"]["asset_code"],
            feature["properties"]["zone_code"],
        )
        for feature in features
        if feature["properties"]["facility_type"].endswith("_sensor")
    }
    assert authored == {
        kind: (profile.asset_code, profile.zone_code) for kind, profile in SENSOR_PROFILES.items()
    }
