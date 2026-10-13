"""What the Scenario validator accepts from the Demo B sources, and what the sources state."""

import json
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fieldloop_common.generated_scenario import Event
from fieldloop_simulator import storm_events
from fieldloop_simulator.scenario import ScenarioError, load_scenario, validate_scenario

FIXTURE = Path(__file__).parent / "fixtures/player-demo-b.json"
START = datetime(2026, 10, 12, tzinfo=UTC)
# The index of each event of the fixture, by what it is.
RAIN, PUMP, RAINFALL, LEVEL = 0, 1, 2, 5


def document() -> dict[str, Any]:
    loaded: dict[str, Any] = json.loads(FIXTURE.read_text())
    return loaded


def test_the_fixture_is_a_valid_scenario() -> None:
    scenario = load_scenario(FIXTURE)
    assert [event.source for event in scenario.events] == [
        "mock-hydro",
        "mock-pumps",
        "mock-hydro",
        "mock-hydro",
        "mock-hydro",
        "mock-hydro",
    ]


@pytest.mark.parametrize(
    ("index", "change", "pointer"),
    [
        (RAIN, {"tag": "rain.intensity"}, "/tag"),
        (RAIN, {"value": "heavy"}, "/value"),
        (RAIN, {"value": None}, "/value"),
        (RAIN, {"value": -1}, "/value"),
        (RAIN, {"value": 1, "noiseAmplitude": 2}, "/value"),
        (RAIN, {"value": 1e308}, "/value"),
        (LEVEL, {"value": -2e6}, "/value"),
        (LEVEL, {"value": 999_999, "noiseAmplitude": 2}, "/value"),
        (RAIN, {"unit": "mm"}, "/unit"),
        (RAIN, {"unit": None}, "/unit"),
        (RAIN, {"target": {"kind": "asset", "id": "S-L1"}}, "/target"),
        (RAIN, {"target": {"kind": "source", "id": "S-R1"}}, "/target"),
        (LEVEL, {"unit": "mm/h"}, "/unit"),
        (RAINFALL, {"value": 120}, "/value"),
        (RAINFALL, {"unit": "mm/h"}, "/unit"),
        (RAINFALL, {"target": {"kind": "asset", "id": "S-T1"}}, "/target"),
        (PUMP, {"target": {"kind": "asset", "id": "P-9"}}, "/target"),
        (PUMP, {"target": {"kind": "barrier", "id": "P-3"}}, "/target"),
        (PUMP, {"tag": "gate.power"}, "/tag"),
        (PUMP, {"value": "off"}, "/value"),
        (PUMP, {"value": True}, "/value"),
        (PUMP, {"unit": "boolean"}, "/unit"),
        (PUMP, {"unit": None}, "/unit"),
    ],
)
def test_an_event_the_source_could_not_publish_is_refused_where_it_is_wrong(
    index: int, change: dict[str, object], pointer: str
) -> None:
    bad = deepcopy(document())
    for field, value in change.items():
        if value is None and field == "unit":
            del bad["events"][index][field]
        else:
            bad["events"][index][field] = value
    with pytest.raises(ScenarioError) as failure:
        validate_scenario(bad)
    assert failure.value.pointer == f"/events/{index}{pointer}"


def test_a_level_may_be_negative_and_a_gate_has_its_own_tag() -> None:
    good = document()
    good["events"][LEVEL]["value"] = -0.2
    good["events"][PUMP].update(target={"kind": "asset", "id": "G-1"}, tag="gate.power")
    validate_scenario(good)


def test_a_reading_is_stated_once_at_any_one_time() -> None:
    twice = document()
    twice["events"].insert(1, twice["events"][RAIN] | {"id": "rain-again", "value": 30})
    with pytest.raises(ScenarioError, match="second event") as failure:
        validate_scenario(twice)
    assert failure.value.pointer == "/events/1/atSeconds"


def test_two_assets_or_two_times_are_two_readings() -> None:
    good = document()
    another_pump = good["events"][PUMP] | {
        "id": "another-pump",
        "target": {"kind": "asset", "id": "P-1"},
    }
    same_pump_later = good["events"][PUMP] | {"id": "power-returns", "value": "available"}
    good["events"].insert(PUMP + 1, another_pump)
    good["events"].append(same_pump_later | {"atSeconds": 14400})
    validate_scenario(good)


def test_other_sources_are_not_judged_by_the_demo_b_rules() -> None:
    event = Event.model_validate(
        {
            "id": "finding",
            "atSeconds": 0,
            "source": "mock-patrol",
            "target": {"kind": "asset", "id": "DL-01"},
            "tag": "anything.at.all",
            "value": 1,
        }
    )
    assert storm_events.check(event) is None
    assert storm_events.describe(event) is None


def test_a_valid_event_is_described_once_with_what_each_caller_needs() -> None:
    described = [storm_events.describe(event) for event in load_scenario(FIXTURE).events]
    assert all(described)
    # (the Asset, counted by the rainfall, shown by a read)
    assert [(item.asset_code, item.rain_rate, item.holds_state) for item in described if item] == [
        ("S-R1", True, True),  # a rain rate
        ("P-3", False, True),  # a pump's power
        ("S-R1", False, False),  # a derived rainfall: no read serves it
        ("S-R1", False, False),
        ("S-R1", True, True),
        ("S-L1", False, True),  # a level is no part of the rainfall
    ]


def test_a_refused_event_is_not_described() -> None:
    refused = document()["events"][PUMP] | {"unit": "boolean"}
    assert storm_events.describe(Event.model_validate(refused)) is None


def test_rainfall_is_what_the_rain_rates_add_up_to_over_24_hours() -> None:
    rates = [(START, 60.0), (START + timedelta(hours=3), 10.0)]
    assert storm_events.rainfall(rates, START + timedelta(hours=2)) == 120
    assert storm_events.rainfall(rates, START + timedelta(hours=4)) == 190
    assert storm_events.rainfall([], START) == 0


def test_the_authoring_guide_shows_events_the_validator_accepts() -> None:
    import re

    import yaml

    guide = (Path(__file__).resolve().parents[3] / "data/scenarios/README.md").read_text()
    (example,) = re.findall(r"```yaml\n(.*?)```", guide, re.DOTALL)
    events = yaml.safe_load(example)
    assert {event["source"] for event in events} == {"mock-hydro", "mock-pumps"}
    validate_scenario({**document(), "events": events, "bookmarks": []})
