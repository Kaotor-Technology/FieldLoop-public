"""Standalone local bibliography loader, not a tool, indexer or citation renderer.

An explicit repository snapshot supplies the shared contracts and catalog files.
No network, licensed full-text corpus, model, database or service registration is
used. These draft observations do not authorize a clause citation (KL-9/Q43).
"""

import json
from collections.abc import Mapping
from pathlib import Path
from types import MappingProxyType
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Invalid reference catalog")
        result[key] = value
    return result


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_unique_object)
    except (ValueError, UnicodeError):
        raise ValueError("Invalid reference catalog") from None


def load_reference_catalog(repo: Path) -> tuple[Mapping[str, Any], ...]:
    """Validate public metadata using the shared contract, separate from full text."""
    catalog = _read_json(repo / "data/corpus/references/manifest.json")
    observations = _read_json(repo / "data/corpus/references/source-observations.json")
    schema = _read_json(repo / "packages/contracts/reference-catalog.v1.schema.json")
    Draft202012Validator.check_schema(schema)
    try:
        Draft202012Validator(schema).validate({"catalog": catalog, "observations": observations})
    except ValidationError:
        raise ValueError("Invalid reference catalog") from None
    # JSON Schema treats 1.0 as an integer; serialized contract is intentionally stricter.
    if type(catalog["schemaVersion"]) is not int:
        raise ValueError("Invalid reference catalog")
    return tuple(
        MappingProxyType({**record, "citationReady": False}) for record in catalog["records"]
    )
