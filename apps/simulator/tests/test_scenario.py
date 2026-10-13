import json
from copy import deepcopy
from pathlib import Path

import pytest
from fieldloop_simulator.scenario import ScenarioError, load_scenario, validate_scenario

FIXTURE = Path(__file__).parent / "fixtures/player.json"


def test_json_and_yaml_agree(tmp_path: Path) -> None:
    import yaml

    document = json.loads(FIXTURE.read_text())
    path = tmp_path / "player.yaml"
    path.write_text(yaml.safe_dump(document))
    assert load_scenario(path) == load_scenario(FIXTURE)


@pytest.mark.parametrize(
    ("field", "value", "pointer"),
    [
        ("simulated", False, "/simulated"),
        ("startsAt", "2026-10-13", "/startsAt"),
        ("durationSeconds", float("inf"), "/durationSeconds"),
        ("classification", "internal", "/classification"),
    ],
)
def test_schema_errors_locate_the_field(field: str, value: object, pointer: str) -> None:
    document = json.loads(FIXTURE.read_text())
    document[field] = value
    with pytest.raises(ScenarioError) as failure:
        validate_scenario(document)
    assert failure.value.pointer == pointer


def test_semantic_errors_locate_the_event() -> None:
    document = json.loads(FIXTURE.read_text())
    for field, value in [("atSeconds", 200), ("id", "baseline")]:
        bad = deepcopy(document)
        bad["events"][1][field] = value
        with pytest.raises(ScenarioError) as failure:
            validate_scenario(bad)
        assert failure.value.pointer == f"/events/1/{field}"
    document["events"][0]["value"] = True
    with pytest.raises(ScenarioError, match="noise requires"):
        validate_scenario(document)


@pytest.mark.parametrize("text", ['{"id":1,"id":2}', "id: 1\nid: 2", "id: &x []\nevents: *x"])
def test_duplicate_keys_and_aliases_are_rejected(tmp_path: Path, text: str) -> None:
    path = tmp_path / ("bad.json" if text.startswith("{") else "bad.yaml")
    path.write_text(text)
    with pytest.raises(ScenarioError):
        load_scenario(path)
