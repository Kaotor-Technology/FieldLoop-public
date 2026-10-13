"""What a Scenario holds a source at, in process, until the next reset (SIM-5)."""

import math
from datetime import datetime


class HeldValues[T]:
    """Values held from a start time on. The latest start wins; among equal starts, the last."""

    def __init__(self) -> None:
        self._held: dict[str, list[tuple[datetime, T]]] = {}

    def hold(self, key: str, *, start: datetime, value: T) -> None:
        if start.tzinfo is None:
            raise ValueError("Override times need a timezone")
        # Copy on write: readers on other threads never see a half-updated list.
        self._held[key] = [*self._held.get(key, []), (start, self._accepted(value))]

    def _accepted(self, value: T) -> T:
        """The value as it is stored; a subclass refuses what its source cannot hold."""
        return value

    def reset(self) -> None:
        self._held = {}

    def starts(self, key: str) -> list[datetime]:
        """The times at which a held value of ``key`` begins, in order."""
        return sorted({start for start, _ in self._held.get(key, [])})

    def at(self, key: str, at: datetime) -> T | None:
        """The value held at ``at``, or ``None`` when the source is at its baseline."""
        if at.tzinfo is None:
            raise ValueError("Reading times need a timezone")
        held = [item for item in self._held.get(key, []) if item[0] <= at]
        if not held:
            return None
        return max(reversed(held), key=lambda item: item[0])[1]


class HeldNumbers(HeldValues[float]):
    """Readings held from a start time on; a reading is a finite number."""

    def _accepted(self, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("Override value must be finite")
        return float(value)
