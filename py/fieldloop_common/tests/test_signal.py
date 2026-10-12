import json
from pathlib import Path

import pytest
from fieldloop_common.signal import is_signal, parse_signal
from jsonschema import ValidationError

ROOT = Path(__file__).resolve().parents[3]
CASES = json.loads((ROOT / "packages/contracts/test/fixtures/signal-cases.json").read_text())


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_shared_wire_cases(case: dict[str, object]) -> None:
    before = json.dumps(case["signal"])
    assert is_signal(case["signal"]) == case["valid"]
    if case["valid"]:
        model = parse_signal(case["signal"])
        assert model.schema_version == "signal.v1"
        assert isinstance(case["signal"], dict)
        assert model.simulated == case["signal"]["simulated"]
    else:
        with pytest.raises(ValidationError):
            parse_signal(case["signal"])
    assert json.dumps(case["signal"]) == before


def test_model_is_generated_and_schema_packaged() -> None:
    assert (ROOT / "packages/contracts/signal.v1.schema.json").read_bytes() == (
        ROOT / "py/fieldloop_common/src/fieldloop_common/signal.v1.schema.json"
    ).read_bytes()


@pytest.mark.parametrize("value", [float("nan"), float("inf"), -float("inf"), json.loads("1e309")])
def test_exported_validators_reject_nonfinite_observations(value: float) -> None:
    signal = {**CASES[0]["signal"], "value": value}
    assert not is_signal(signal)
    with pytest.raises(ValidationError):
        parse_signal(signal)
