"""Bounded YAML/JSON Scenario loading with schema and timeline error locations (SIM-1)."""

import json
from datetime import datetime, timedelta
from importlib.resources import files
from pathlib import Path
from typing import Any

import yaml  # type: ignore[import-untyped]
from fieldloop_common.generated_scenario import Scenario
from jsonschema import Draft202012Validator, FormatChecker

from fieldloop_simulator.mock_historian import TAG_PROFILES

MAX_SCENARIO_BYTES = 1024 * 1024
SCHEMA = json.loads(files("fieldloop_common").joinpath("scenario.v1.schema.json").read_text())
VALIDATOR = Draft202012Validator(SCHEMA, format_checker=FormatChecker())


class ScenarioError(ValueError):
    def __init__(self, pointer: str, reason: str) -> None:
        self.pointer = pointer
        self.reason = reason
        super().__init__(f"{pointer or '/'}: {reason}")


def validate_scenario(document: object) -> Scenario:
    errors = sorted(VALIDATOR.iter_errors(document), key=lambda e: str(list(e.absolute_path)))
    if errors:
        error = errors[0]
        pointer = "/" + "/".join(
            str(part).replace("~", "~0").replace("/", "~1") for part in error.absolute_path
        )
        # Report the schema rule and position, never echo an untrusted payload or secret.
        raise ScenarioError(pointer, f"violates {error.validator}")
    scenario = Scenario.model_validate(document, strict=True)
    event_ids: set[str] = set()
    previous = -1.0
    for index, event in enumerate(scenario.events):
        prefix = f"/events/{index}"
        if event.id in event_ids:
            raise ScenarioError(prefix + "/id", "duplicate event ID")
        event_ids.add(event.id)
        if event.source == "mock-historian":
            profile = TAG_PROFILES.get(event.tag)
            if profile is None:
                raise ScenarioError(prefix + "/tag", "unknown installed historian tag")
            if isinstance(event.value, bool) or not isinstance(event.value, (float, int)):
                raise ScenarioError(prefix + "/value", "historian readings must be numeric")
            if event.unit != profile.unit:
                raise ScenarioError(prefix + "/unit", "unit differs from the source API")
        if event.at_seconds < previous or event.at_seconds > scenario.duration_seconds:
            raise ScenarioError(
                prefix + "/atSeconds", "timeline is unordered or beyond its duration"
            )
        previous = event.at_seconds
        if event.noise_amplitude is not None and (
            isinstance(event.value, bool) or not isinstance(event.value, (int, float))
        ):
            raise ScenarioError(prefix + "/noiseAmplitude", "noise requires a numeric value")
    bookmark_ids: set[str] = set()
    for index, bookmark in enumerate(scenario.bookmarks):
        if bookmark.id in bookmark_ids or bookmark.at_seconds > scenario.duration_seconds:
            raise ScenarioError(f"/bookmarks/{index}", "duplicate bookmark or time beyond duration")
        bookmark_ids.add(bookmark.id)
    try:
        datetime.fromisoformat(
            scenario.starts_at.replace("Z", "+00:00").replace("z", "+00:00")
        ) + timedelta(seconds=scenario.duration_seconds)
    except (ValueError, OverflowError) as error:
        raise ScenarioError("/startsAt", "timeline is outside the supported date range") from error
    return scenario


def load_scenario(path: Path) -> Scenario:
    raw = path.read_bytes()
    if len(raw) > MAX_SCENARIO_BYTES:
        raise ScenarioError("/", "file exceeds 1 MiB")
    try:
        text = raw.decode("utf-8")
        if path.suffix == ".json":
            document = json.loads(text, object_pairs_hook=_unique_pairs)
        else:
            # Aliases can expand exponentially. Do not allow them in a Scenario.
            if any(isinstance(event, yaml.AliasEvent) for event in yaml.parse(text)):
                raise ScenarioError("/", "YAML aliases are not allowed")
            document = yaml.load(text, Loader=_ScenarioLoader)
    except (UnicodeError, json.JSONDecodeError, yaml.YAMLError) as error:
        mark = getattr(error, "problem_mark", None)
        location = f"line {mark.line + 1}, column {mark.column + 1}" if mark else "/"
        raise ScenarioError(location, "invalid UTF-8, JSON or YAML") from error
    return validate_scenario(document)


def _unique_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ScenarioError("/", "duplicate mapping key")
        result[key] = value
    return result


class _ScenarioLoader(yaml.SafeLoader):  # type: ignore[misc]
    # YAML timestamps remain strings, as required by the wire schema.
    yaml_implicit_resolvers = {
        key: [item for item in value if item[0] != "tag:yaml.org,2002:timestamp"]
        for key, value in yaml.SafeLoader.yaml_implicit_resolvers.items()
    }

    def construct_mapping(self, node: Any, deep: bool = False) -> dict[str, object]:
        pairs = [
            (self.construct_object(key, deep=deep), self.construct_object(value, deep=deep))
            for key, value in node.value
        ]
        return _unique_pairs(pairs)


def load_catalog(directory: Path) -> dict[str, Scenario]:
    catalog: dict[str, Scenario] = {}
    if not directory.is_dir():
        return catalog
    for path in sorted(directory.iterdir()):
        if path.suffix not in (".json", ".yaml", ".yml"):
            continue
        scenario = load_scenario(path)
        if scenario.id in catalog:
            raise ScenarioError("/id", "duplicate Scenario ID in catalog")
        catalog[scenario.id] = scenario
    return catalog
