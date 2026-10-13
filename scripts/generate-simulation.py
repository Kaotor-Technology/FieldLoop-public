"""Generate installed Scenario/player models and schemas from the shared contracts."""

import shutil
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
package = root / "py/fieldloop_common/src/fieldloop_common"
for name in ("scenario", "simulation"):
    schema = root / f"packages/contracts/{name}.v1.schema.json"
    subprocess.run(
        [
            "datamodel-codegen",
            "--input",
            str(schema),
            "--input-file-type",
            "jsonschema",
            "--output",
            str(package / f"generated_{name}.py"),
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
    shutil.copyfile(schema, package / schema.name)
