import json
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.routing import APIRoute
from fieldloop_simulator.main import app

ROOT = Path(__file__).resolve().parents[3]
CONTRACTS = ROOT / "packages/contracts"
# A source is a mock-<source>.v1.schema.json file; nothing here is edited to add one.
SOURCES = sorted(
    path.name.removeprefix("mock-").removesuffix(".v1.schema.json")
    for path in CONTRACTS.glob("mock-*.v1.schema.json")
)


def served_paths() -> set[str]:
    return {
        route.path
        for route in app.routes
        if isinstance(route, APIRoute) and route.path.startswith("/mock/")
    }


def documented_paths() -> set[str]:
    paths: set[str] = set()
    for source in SOURCES:
        contract = json.loads((CONTRACTS / f"mock-{source}.v1.openapi.json").read_text())
        paths |= set(contract["paths"])
    return paths


def test_the_contract_files_are_found() -> None:
    assert {"historian", "patrol", "ili"} <= set(SOURCES)


def test_the_documented_paths_are_the_served_paths() -> None:
    # A route without a contract, or a contract without a route, is drift.
    assert served_paths() == documented_paths()


@pytest.mark.parametrize("source", SOURCES)
def test_generated_response_model_has_no_contract_drift(source: str, tmp_path: Path) -> None:
    output = tmp_path / "generated.py"
    subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts/generate_mock_source.py"),
            source,
            "--output",
            str(output),
        ],
        check=True,
    )
    committed = ROOT / f"py/fieldloop_common/src/fieldloop_common/generated_mock_{source}.py"
    assert output.read_bytes() == committed.read_bytes()


@pytest.mark.parametrize("source", SOURCES)
def test_the_contract_serves_its_own_schema_and_documents_the_refused_methods(source: str) -> None:
    # The /mock/ root, GET only, and Problem error bodies are `.spectral.mock.yaml` rules.
    contract = json.loads((CONTRACTS / f"mock-{source}.v1.openapi.json").read_text())
    assert contract["paths"]
    for item in contract["paths"].values():
        responses = item["get"]["responses"]
        assert responses["200"]["content"]["application/json"]["schema"] == {
            "$ref": f"mock-{source}.v1.schema.json"
        }
        assert "405" in responses
