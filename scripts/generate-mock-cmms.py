"""Generate the mock CMMS response model from its canonical JSON Schema."""

import argparse
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument(
    "--output",
    type=Path,
    default=root / "py/fieldloop_common/src/fieldloop_common/generated_mock_cmms.py",
)
output = parser.parse_args().output
subprocess.run(
    [
        "datamodel-codegen",
        "--input",
        str(root / "packages/contracts/mock-cmms.v1.schema.json"),
        "--input-file-type",
        "jsonschema",
        "--output",
        str(output),
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
# Apply the same repository formatting even when a drift test writes outside the worktree.
subprocess.run(
    ["ruff", "check", "--config", str(root / "pyproject.toml"), "--fix", str(output)],
    check=True,
)
subprocess.run(
    ["ruff", "format", "--config", str(root / "pyproject.toml"), str(output)],
    check=True,
)
