"""Canonical, non-coercing Signal validation shared with TypeScript."""

import json
import math
from importlib.resources import files

from jsonschema import Draft202012Validator, FormatChecker, ValidationError

from fieldloop_common.generated_signal import Signal

SIGNAL_SCHEMA = json.loads(files("fieldloop_common").joinpath("signal.v1.schema.json").read_text())
Draft202012Validator.check_schema(SIGNAL_SCHEMA)
_VALIDATOR = Draft202012Validator(SIGNAL_SCHEMA, format_checker=FormatChecker())


def _is_finite_observation(value: object) -> bool:
    # JSON Schema's default Python number checker also accepts NaN/Infinity.
    # Match Ajv's strictNumbers behavior for JSON observation values.
    if isinstance(value, dict):
        observation = value.get("value")
        if isinstance(observation, float):
            return math.isfinite(observation)
    return True


def is_signal(value: object) -> bool:
    """Check the wire object before Pydantic can coerce any values."""
    return _is_finite_observation(value) and _VALIDATOR.is_valid(value)


def parse_signal(value: object) -> Signal:
    """Use generated model names in Python; serialize with by_alias=True."""
    if not _is_finite_observation(value):
        raise ValidationError("Signal observation must be finite", path=["value"])
    _VALIDATOR.validate(value)
    return Signal.model_validate(value)
