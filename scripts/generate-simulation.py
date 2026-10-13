"""Generate installed Scenario/player models and schemas from the shared contracts."""

import json
import shutil
import subprocess
from pathlib import Path

import yaml

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

# Embed the canonical schemas in OpenAPI so the downloadable contract is self-contained.
openapi = root / "packages/contracts/openapi.yaml"
source = openapi.read_text()
start_marker = "    # BEGIN generated simulation schemas\n"
end_marker = "    # END generated simulation schemas\n"
models = json.loads((root / "packages/contracts/simulation.v1.schema.json").read_text())["$defs"]
block = start_marker + "".join(
    "    " + line + "\n" for line in yaml.safe_dump(models, sort_keys=False, width=100).splitlines()
) + end_marker
if start_marker in source:
    start = source.index(start_marker)
    end = source.index(end_marker, start) + len(end_marker)
else:
    start = source.index("    SimulationRun:\n")
    end = source.index("    CurrentUser:\n", start)
openapi.write_text(source[:start] + block + source[end:])
