"""Timestamp handling shared by the mock sources and the Signal emitter."""

from datetime import UTC, datetime, timedelta

EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


def to_utc(value: datetime) -> datetime:
    """The same instant in UTC.

    A valid offset timestamp near year 1 or 9999 has no UTC datetime. That is bad input, so it is
    a ``ValueError`` and never an ``OverflowError`` that surfaces as a 500.
    """
    try:
        return value.astimezone(UTC)
    except OverflowError as error:
        raise ValueError("Timestamp is outside the supported range") from error


def triangle_wave(at: datetime, period: timedelta) -> float:
    """A wave of ``period`` on the UTC clock, from 1 at its start through -1 at half way.

    A triangle keeps this to correctly rounded IEEE operations, so a synthetic series is
    identical across platforms (a sine would depend on the C library).
    """
    return 4 * abs(((at - EPOCH) % period) / period - 0.5) - 1
