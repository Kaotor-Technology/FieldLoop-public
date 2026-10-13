import asyncio
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
    document["events"][2]["value"] = True
    with pytest.raises(ScenarioError, match="noise requires"):
        validate_scenario(document)


def test_loading_rejects_unknown_asset_targets_with_a_json_pointer(tmp_path: Path) -> None:
    document = json.loads(FIXTURE.read_text())
    document["events"][1]["target"]["id"] = "UNKNOWN-ASSET"
    path = tmp_path / "unknown-asset.json"
    path.write_text(json.dumps(document))
    with pytest.raises(ScenarioError) as failure:
        load_scenario(path, asset_codes={"DL-01", "S-R1"})
    assert failure.value.pointer == "/events/1/target/id"


def test_loading_accepts_asset_targets_in_the_organisation() -> None:
    scenario = load_scenario(FIXTURE, asset_codes={"DL-01", "S-R1"})
    assert scenario.events[0].target.id == "DL-01"


def test_service_catalog_validation_fails_before_startup_for_an_unknown_asset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import fieldloop_simulator.main as simulator_main

    document = json.loads(FIXTURE.read_text())
    document["events"][1]["target"]["id"] = "UNKNOWN-ASSET"
    scenario = validate_scenario(document)

    class FakeAssetStore:
        def asset_codes(self) -> set[str]:
            return {"DL-01", "S-R1"}

    fake_store = FakeAssetStore()

    def store() -> FakeAssetStore:
        return fake_store

    monkeypatch.setattr(simulator_main, "store", store)
    monkeypatch.setattr(simulator_main, "catalog", {scenario.id: scenario})

    async def start_service() -> None:
        async with simulator_main.lifespan(simulator_main.app):
            pass

    with pytest.raises(RuntimeError, match="/events/1/target/id: unknown Asset"):
        asyncio.run(start_service())


@pytest.mark.parametrize("text", ['{"id":1,"id":2}', "id: 1\nid: 2", "id: &x []\nevents: *x"])
def test_duplicate_keys_and_aliases_are_rejected(tmp_path: Path, text: str) -> None:
    path = tmp_path / ("bad.json" if text.startswith("{") else "bad.yaml")
    path.write_text(text)
    with pytest.raises(ScenarioError):
        load_scenario(path)


@pytest.mark.parametrize("value", [float("nan"), float("inf"), 10**400])
def test_nonfinite_measurements_are_rejected_at_their_position(value: object) -> None:
    document = json.loads(FIXTURE.read_text())
    document["events"][0]["value"] = value
    with pytest.raises(ScenarioError) as failure:
        validate_scenario(document)
    assert failure.value.pointer == "/events/0/value"


def test_event_size_is_checked_before_a_run_can_start() -> None:
    document = json.loads(FIXTURE.read_text())
    document["events"][0]["payload"] = {"oversized": "x" * (256 * 1024)}
    with pytest.raises(ScenarioError, match="publication size budget"):
        validate_scenario(document)


def test_timestamp_offsets_are_normalised_and_overflow_is_rejected() -> None:
    document = json.loads(FIXTURE.read_text())
    document["startsAt"] = "2026-10-13T07:00:00+07:00"
    assert validate_scenario(document).starts_at == "2026-10-13T00:00:00Z"
    document["startsAt"] = "0001-01-01T00:00:00+07:00"
    with pytest.raises(ScenarioError):
        validate_scenario(document)


def test_scenario_identifiers_cannot_invalidate_the_signal_contract() -> None:
    document = json.loads(FIXTURE.read_text())
    document["events"][2]["tag"] += "\n"
    with pytest.raises(ScenarioError) as failure:
        validate_scenario(document)
    assert failure.value.pointer == "/events/2/tag"


@pytest.mark.parametrize("source", ["mock-rain", "mock-level", "mock-tide", "mock-pump"])
def test_scenario_source_names_are_publisher_ids_not_sensor_aliases(source: str) -> None:
    document = json.loads(FIXTURE.read_text())
    document["events"][2]["source"] = source
    with pytest.raises(ScenarioError) as failure:
        validate_scenario(document)
    assert failure.value.pointer == "/events/2/source"
