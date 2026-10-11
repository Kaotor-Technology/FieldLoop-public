"""Regenerate the installed Python contract from the canonical JSON Schema."""

import shutil
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
schema = root / "packages/contracts/signal.v1.schema.json"
package = root / "py/fieldloop_common/src/fieldloop_common"
subprocess.run(
    [
        "datamodel-codegen",
        "--input",
        str(schema),
        "--input-file-type",
        "jsonschema",
        "--output",
        str(package / "generated_signal.py"),
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
        "--use-object-type",
        "--use-annotated",
        "--formatters",
        "ruff-check",
        "ruff-format",
        "--type-mappings",
        "string+date-time=string",
    ],
    check=True,
)
shutil.copyfile(schema, package / "signal.v1.schema.json")
subprocess.run(["ruff", "check", "--fix", str(package / "generated_signal.py")], check=True)
