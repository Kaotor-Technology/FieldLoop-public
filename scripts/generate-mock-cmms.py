"""Generate the mock CMMS response model from its canonical JSON Schema."""

import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
subprocess.run(
    [
        "datamodel-codegen",
        "--input",
        str(root / "packages/contracts/mock-cmms.v1.schema.json"),
        "--input-file-type",
        "jsonschema",
        "--output",
        str(root / "py/fieldloop_common/src/fieldloop_common/generated_mock_cmms.py"),
        "--output-model-type",
        "pydantic_v2.BaseModel",
        "--target-python-version",
        "3.12",
        "--snake-case-field",
        "--enum-field-as-literal",
        "all",
        "--disable-timestamp",
        "--use-union-operator",
        "--use-standard-collections",
        "--use-annotated",
        "--formatters",
        "ruff-check",
        "ruff-format",
    ],
    check=True,
)
