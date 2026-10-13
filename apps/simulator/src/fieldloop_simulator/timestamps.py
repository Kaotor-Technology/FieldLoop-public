"""Timestamp handling shared by the mock sources and the Signal emitter."""

from datetime import UTC, datetime


def to_utc(value: datetime) -> datetime:
    """The same instant in UTC.

    A valid offset timestamp near year 1 or 9999 has no UTC datetime. That is bad input, so it is
    a ``ValueError`` and never an ``OverflowError`` that surfaces as a 500.
    """
    try:
        return value.astimezone(UTC)
    except OverflowError as error:
        raise ValueError("Timestamp is outside the supported range") from error
