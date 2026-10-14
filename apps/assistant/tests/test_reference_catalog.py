import importlib
import json
from pathlib import Path
from types import ModuleType

import pytest

REPO = Path(__file__).resolve().parents[3]


def loader() -> ModuleType:
    try:
        return importlib.import_module("fieldloop_assistant.reference_catalog")
    except ModuleNotFoundError:
        pytest.fail("Standalone reference catalog loader is missing")


def test_loads_reviewed_bibliographic_metadata_without_full_text() -> None:
    records = loader().load_reference_catalog(REPO)
    # Independent literal oracle from the separate publisher-metadata review, not observations.
    assert [(r["standard"], r["edition"], r["title"]) for r in records] == [
        ("ASME B31.8", "2025", "Gas Transmission and Distribution Piping Systems"),
        ("ASME B31.8S", "2025", "Managing System Integrity of Gas Pipelines"),
        ("API RP 1160", "3rd Edition", "Managing System Integrity for Hazardous Liquid Pipelines"),
    ]
    assert all(r["clause"] is None and "text" not in r for r in records)


def test_missing_clause_is_explicitly_not_citation_ready() -> None:
    records = loader().load_reference_catalog(REPO)
    assert all(r.get("citationReady") is False for r in records)
    assert all(r["status"] == "draft" for r in records)


def catalog_copy(tmp_path: Path) -> Path:
    directory = tmp_path / "data/corpus/references"
    directory.mkdir(parents=True)
    for name in ("manifest.json", "source-observations.json"):
        (directory / name).write_bytes((REPO / "data/corpus/references" / name).read_bytes())
    contract = REPO / "packages/contracts/reference-catalog.v1.schema.json"
    if contract.exists():
        target = tmp_path / "packages/contracts/reference-catalog.v1.schema.json"
        target.parent.mkdir(parents=True)
        target.write_bytes(contract.read_bytes())
    return tmp_path


@pytest.mark.parametrize("field,value", [
    ("text", "PROHIBITED"), ("content", "PROHIBITED"), ("fullText", "PROHIBITED"),
    ("chunks", []), ("embedding", []), ("quote", "PROHIBITED"),
    ("status", "current"), ("classification", "INTERNAL"),
    ("contentState", "full_text"), ("clause", "invented clause"),
    ("editionCurrency", "latest"), ("verificationLabel", "verified"),
    ("citationReady", True), ("approval", True),
])
def test_loader_rejects_full_text_or_promoted_record(
    tmp_path: Path, field: str, value: object,
) -> None:
    root = catalog_copy(tmp_path)
    path = root / "data/corpus/references/manifest.json"
    document = json.loads(path.read_text())
    document["records"][0][field] = value
    path.write_text(json.dumps(document))
    with pytest.raises(ValueError, match="Invalid reference catalog"):
        loader().load_reference_catalog(root)


@pytest.mark.parametrize("index", [0, 1, 2])
@pytest.mark.parametrize("field,value", [
    ("edition", "2099"), ("title", "Invented title"),
    ("sourceUrl", "https://example.invalid/not-official"),
    ("publisher", "Invented publisher"), ("standard", "Invented standard"),
    ("observedHeading", "Invented heading"),
])
def test_coupled_catalog_observation_drift_cannot_replace_reviewed_oracle(
    tmp_path: Path, index: int, field: str, value: str,
) -> None:
    root = catalog_copy(tmp_path)
    for filename, array in (("manifest.json", "records"),
                            ("source-observations.json", "observations")):
        path = root / "data/corpus/references" / filename
        document = json.loads(path.read_text())
        document[array][index][field] = value
        path.write_text(json.dumps(document))
    with pytest.raises(ValueError, match="Invalid reference catalog"):
        loader().load_reference_catalog(root)


@pytest.mark.parametrize("mode", ["empty", "duplicate", "extra", "missing"])
def test_catalog_requires_each_reviewed_identity_exactly_once(tmp_path: Path, mode: str) -> None:
    root = catalog_copy(tmp_path)
    path = root / "data/corpus/references/manifest.json"
    document = json.loads(path.read_text())
    if mode == "empty":
        document["records"] = []
    elif mode == "duplicate":
        document["records"][1] = document["records"][0]
    elif mode == "extra":
        document["records"].append(document["records"][0])
    else:
        document["records"].pop()
    path.write_text(json.dumps(document))
    with pytest.raises(ValueError, match="Invalid reference catalog"):
        loader().load_reference_catalog(root)


@pytest.mark.parametrize("field,value", [
    ("method", "Inferred"), ("observedDateUtc", "2099-01-01"),
    ("observedDateUtc", "2026-02-30"), ("limits", []), ("limits", ["Approved"]),
    ("text", "PROHIBITED"), ("approval", True), ("observations", []),
])
def test_observation_envelope_cannot_lose_provenance_or_limits(
    tmp_path: Path, field: str, value: object,
) -> None:
    root = catalog_copy(tmp_path)
    path = root / "data/corpus/references/source-observations.json"
    document = json.loads(path.read_text())
    document[field] = value
    path.write_text(json.dumps(document))
    with pytest.raises(ValueError, match="Invalid reference catalog"):
        loader().load_reference_catalog(root)


@pytest.mark.parametrize("mode", ["duplicate", "missing", "unobserved", "text", "null"])
def test_observations_require_complete_unique_reviewed_metadata(tmp_path: Path, mode: str) -> None:
    root = catalog_copy(tmp_path)
    path = root / "data/corpus/references/source-observations.json"
    document = json.loads(path.read_text())
    if mode == "duplicate":
        document["observations"][1] = document["observations"][0]
    elif mode == "missing":
        document["observations"][0].pop("edition")
    elif mode == "unobserved":
        document["observations"][0]["edition"] = "2099"
    elif mode == "text":
        document["observations"][0]["text"] = "PROHIBITED"
    else:
        document["observations"][0] = None
    path.write_text(json.dumps(document))
    with pytest.raises(ValueError, match="Invalid reference catalog"):
        loader().load_reference_catalog(root)


@pytest.mark.parametrize("version", [1.0, True, "1", 0, 2, None])
def test_serialized_version_must_be_exact_integer_one(tmp_path: Path, version: object) -> None:
    root = catalog_copy(tmp_path)
    path = root / "data/corpus/references/manifest.json"
    document = json.loads(path.read_text())
    document["schemaVersion"] = version
    path.write_text(json.dumps(document))
    with pytest.raises(ValueError, match="Invalid reference catalog"):
        loader().load_reference_catalog(root)


@pytest.mark.parametrize("filename,key", [
    ("manifest.json", "schemaVersion"), ("source-observations.json", "method"),
])
def test_duplicate_json_keys_are_not_silently_discarded(
    tmp_path: Path, filename: str, key: str,
) -> None:
    root = catalog_copy(tmp_path)
    path = root / "data/corpus/references" / filename
    document = json.loads(path.read_text())
    raw = path.read_text()
    entry = json.dumps(key) + ": " + json.dumps(document[key])
    path.write_text(raw.replace(entry, entry + ", " + entry, 1))
    with pytest.raises(ValueError, match="Invalid reference catalog"):
        loader().load_reference_catalog(root)


def test_malformed_json_fails_without_exporting_input(tmp_path: Path) -> None:
    root = catalog_copy(tmp_path)
    (root / "data/corpus/references/manifest.json").write_text('{"PROHIBITED":')
    with pytest.raises(ValueError, match="^Invalid reference catalog$"):
        loader().load_reference_catalog(root)


def test_loaded_metadata_cannot_be_promoted_by_mutating_result() -> None:
    record = loader().load_reference_catalog(REPO)[0]
    with pytest.raises(TypeError):
        record["citationReady"] = True
    with pytest.raises(TypeError):
        record["status"] = "current"
    assert record["citationReady"] is False and record["clause"] is None
