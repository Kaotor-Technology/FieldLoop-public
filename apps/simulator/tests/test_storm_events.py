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
    assert storm_events.payload(event, 1) == {}


def test_only_an_event_that_a_read_shows_holds_state() -> None:
    events = load_scenario(FIXTURE).events
    assert [storm_events.holds_state(event) for event in events] == [
        True,  # a rain rate
        True,  # a pump's power
        False,  # a derived rainfall: no read serves it
        False,
        True,
        True,
    ]


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
