"""Generate a mock source response model from its canonical JSON Schema."""

import argparse
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("source", choices=("historian", "patrol"))
parser.add_argument("--output", type=Path)
args = parser.parse_args()
output = args.output or (
    root / f"py/fieldloop_common/src/fieldloop_common/generated_mock_{args.source}.py"
)
subprocess.run(
    [
        "datamodel-codegen",
        "--input",
        str(root / f"packages/contracts/mock-{args.source}.v1.schema.json"),
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
        "builtin",
    ],
    check=True,
)
# Format with the repository configuration, not whatever sits next to --output: the builtin
# formatter is location-independent, so a drift test may write outside the worktree.
subprocess.run(
    ["ruff", "check", "--config", str(root / "pyproject.toml"), "--fix", str(output)],
    check=True,
)
subprocess.run(
    ["ruff", "format", "--config", str(root / "pyproject.toml"), str(output)],
    check=True,
)
