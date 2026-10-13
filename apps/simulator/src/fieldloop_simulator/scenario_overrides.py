"""What a Scenario holds a source at, in process, until the next reset (SIM-5)."""

from dataclasses import dataclass
from datetime import datetime


class HeldValues[T]:
    """Values held from a start time on. The latest start wins; among equal starts, the last."""

    def __init__(self) -> None:
        self._held: dict[str, list[tuple[datetime, T]]] = {}

    def hold(self, key: str, *, start: datetime, value: T) -> None:
        if start.tzinfo is None:
            raise ValueError("Override times need a timezone")
        # Copy on write: readers on other threads never see a half-updated list.
        self._held[key] = [*self._held.get(key, []), (start, value)]

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


@dataclass(frozen=True)
class RunState[T]:
    """What a run holds a source at, with the run's clock.

    A source keeps one and replaces it whole, so a request that reads while a run is being
    replayed sees the run as it was or as it is, never a part of either.
    """

    held: HeldValues[T]
    clock: datetime
