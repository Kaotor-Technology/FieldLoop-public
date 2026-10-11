"""Canonical, non-coercing Signal validation shared with TypeScript."""

import json
from importlib.resources import files

from jsonschema import Draft202012Validator, FormatChecker

from fieldloop_common.generated_signal import Signal

SIGNAL_SCHEMA = json.loads(files("fieldloop_common").joinpath("signal.v1.schema.json").read_text())
Draft202012Validator.check_schema(SIGNAL_SCHEMA)
_VALIDATOR = Draft202012Validator(SIGNAL_SCHEMA, format_checker=FormatChecker())


def is_signal(value: object) -> bool:
    """Check the wire object before Pydantic can coerce any values."""
    return _VALIDATOR.is_valid(value)


def parse_signal(value: object) -> Signal:
    """Use generated model names in Python; serialize with by_alias=True."""
    _VALIDATOR.validate(value)
    return Signal.model_validate(value)
