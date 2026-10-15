"""Generate the installed Python Geo Reference models from the OpenAPI contract."""

import copy
import json
import subprocess
import tempfile
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
OPENAPI = ROOT / "packages/contracts/openapi.yaml"
OUTPUT = ROOT / "py/fieldloop_common/src/fieldloop_common/generated_geo_reference.py"


def replace_candidate_refs(value: object) -> object:
    if isinstance(value, list):
        return [replace_candidate_refs(item) for item in value]
    if not isinstance(value, dict):
        return value
    return {
        key: (
            "#/$defs/GeoReferenceCandidate"
            if key == "$ref" and child == "#/components/schemas/GeoReferenceCandidate"
            else replace_candidate_refs(child)
        )
        for key, child in value.items()
    }


def main() -> None:
    openapi = yaml.safe_load(OPENAPI.read_text())
    schemas = openapi["components"]["schemas"]
    draft_schema = copy.deepcopy(schemas["GeoReferenceDraftCreate"])
    candidate_schema = copy.deepcopy(schemas["GeoReferenceCandidate"])
    draft_schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    draft_schema["title"] = "GeoReferenceDraftCreate"
    draft_schema["$defs"] = {"GeoReferenceCandidate": candidate_schema}
    draft_schema = replace_candidate_refs(draft_schema)

    with tempfile.TemporaryDirectory(prefix="fieldloop-geo-contract-") as temp_dir:
        schema_path = Path(temp_dir) / "geo-reference.schema.json"
        schema_path.write_text(json.dumps(draft_schema, indent=2) + "\n")
        subprocess.run(
            [
                "datamodel-codegen",
                "--input",
                str(schema_path),
                "--input-file-type",
                "jsonschema",
                "--output",
                str(OUTPUT),
                "--output-model-type",
                "pydantic_v2.BaseModel",
                "--target-python-version",
                "3.12",
                "--snake-case-field",
                "--disable-timestamp",
                "--use-union-operator",
                "--use-standard-collections",
                "--use-object-type",
                "--use-annotated",
                "--formatters",
                "ruff-check",
                "ruff-format",
            ],
            check=True,
        )
    subprocess.run(["ruff", "check", "--fix", str(OUTPUT)], check=True)


if __name__ == "__main__":
    main()
