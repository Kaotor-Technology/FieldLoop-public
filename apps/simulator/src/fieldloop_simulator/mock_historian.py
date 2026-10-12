"""Deterministic, read-only synthetic SCADA historian for Demo A (SIM-2).

Every value is a pure function of tag, timestamp and seed, plus any Scenario override. There is
no wall clock, no randomness and no I/O, so a fixed seed reproduces a run (SIM-5). The HTTP side
is read-only; a Scenario changes the series in process through ``add_override``.
"""

import hashlib
import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import Depends, Query, Request
from fastapi.responses import JSONResponse
from fieldloop_common.generated_mock_historian import MockHistorianSeries

from fieldloop_simulator.mock_http import ReadOnlyRouter, Rfc3339, problem

DEMO_ORG_ID = "fieldloop-demo"
DEMO_SEED = 20261018
SAMPLE_INTERVAL = timedelta(seconds=60)
MAX_WINDOW = timedelta(hours=24)

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
_DAY_SECONDS = 86_400
_ORG_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")


@dataclass(frozen=True)
class TagProfile:
    """Illustrative synthetic behaviour of one tag; these are not operating figures."""

    unit: str
    description: str
    base: float
    swing: float
    noise: float


TAG_PROFILES: Mapping[str, TagProfile] = {
    "DL-01.pressure.line": TagProfile(
        unit="bar",
        description="Synthetic line pressure at the DL-01 inlet station",
        base=62.0,
        swing=1.5,
        noise=0.1,
    ),
    "DL-01.flow.line": TagProfile(
        unit="m3/h",
        description="Synthetic line flow at the DL-01 inlet station",
        base=1200.0,
        swing=60.0,
        noise=5.0,
    ),
    "DL-01.rectifier.output": TagProfile(
        unit="A",
        description="Synthetic cathodic-protection rectifier output current",
        base=12.0,
        swing=0.4,
        noise=0.05,
    ),
}


@dataclass(frozen=True)
class _Override:
    start: datetime
    end: datetime | None
    value: float


class SimulatedHistorian:
    def __init__(self, *, seed: int = DEMO_SEED, org_id: str = DEMO_ORG_ID) -> None:
        if _ORG_ID.fullmatch(org_id) is None:
            raise ValueError("Invalid Organisation ID")
        self.seed = seed
        self.org_id = org_id
        self._overrides: dict[str, list[_Override]] = {}

    def profile(self, tag: str) -> TagProfile:
        return TAG_PROFILES[tag]

    def add_override(
        self, tag: str, *, start: datetime, value: float, end: datetime | None = None
    ) -> None:
        """Hold a tag at ``value`` from ``start`` (inclusive) until ``end`` (exclusive)."""
        if tag not in TAG_PROFILES:
            raise KeyError(tag)
        if start.tzinfo is None or (end is not None and end.tzinfo is None):
            raise ValueError("Override times need a timezone")
        if end is not None and end <= start:
            raise ValueError("Override must end after it starts")
        if not math.isfinite(value):
            raise ValueError("Override value must be finite")
        # Copy on write: readers on other threads never see a half-updated list.
        self._overrides[tag] = [*self._overrides.get(tag, []), _Override(start, end, float(value))]

    def clear_overrides(self) -> None:
        self._overrides = {}

    def value_at(self, tag: str, at: datetime) -> float:
        held = [
            item
            for item in self._overrides.get(tag, [])
            if item.start <= at and (item.end is None or at < item.end)
        ]
        if held:
            # The latest start wins; among equal starts, the override added last.
            return max(reversed(held), key=lambda item: item.start).value
        profile = TAG_PROFILES[tag]
        second = (at - _EPOCH) // timedelta(seconds=1)
        # A triangle wave and a hash keep this to correctly rounded IEEE operations, so it is
        # identical across platforms (a sine would depend on the C library).
        wave = 4 * abs((second % _DAY_SECONDS) / _DAY_SECONDS - 0.5) - 1
        digest = hashlib.sha256(f"{self.seed}|{tag}|{second}".encode()).digest()
        jitter = int.from_bytes(digest[:8], "big") / 2**64
        return round(profile.base + profile.swing * wave + profile.noise * (2 * jitter - 1), 3)

    def series(self, tag: str, start: datetime, end: datetime) -> list[tuple[datetime, float]]:
        """Samples on the UTC clock grid inside ``start``..``end`` inclusive."""
        first = -((_EPOCH - start) // SAMPLE_INTERVAL)
        last = (end - _EPOCH) // SAMPLE_INTERVAL
        times = [_EPOCH + index * SAMPLE_INTERVAL for index in range(first, last + 1)]
        return [(at, self.value_at(tag, at)) for at in times]


router = ReadOnlyRouter(prefix="/mock/historian", tag="mock-historian")


def get_historian(request: Request) -> SimulatedHistorian:
    historian = request.app.state.historian
    if not isinstance(historian, SimulatedHistorian):
        raise RuntimeError("The simulator has no historian configured")
    return historian


@router.read("/tags/{tag}", response_model=MockHistorianSeries)
def read_tag(
    tag: str,
    start: Annotated[Rfc3339, Query(alias="from")],
    end: Annotated[Rfc3339, Query(alias="to")],
    historian: Annotated[SimulatedHistorian, Depends(get_historian)],
) -> MockHistorianSeries | JSONResponse:
    if tag not in TAG_PROFILES:
        return problem(404, "Unknown historian tag", "not_found")
    if end <= start or end - start > MAX_WINDOW:
        return problem(400, "Invalid historian window", "validation_failed")
    profile = historian.profile(tag)
    start_utc = start.astimezone(UTC)
    end_utc = end.astimezone(UTC)
    points = [
        {"t": at, "v": value, "quality": "good"}
        for at, value in historian.series(tag, start_utc, end_utc)
    ]
    return MockHistorianSeries.model_validate(
        {
            "tag": tag,
            "unit": profile.unit,
            "description": profile.description,
            "from": start_utc,
            "to": end_utc,
            "intervalSeconds": int(SAMPLE_INTERVAL.total_seconds()),
            "points": points,
            "total": len(points),
            "source": "mock-historian",
            "orgId": historian.org_id,
            "assetCode": "DL-01",
            "label": "SYNTHETIC",
            "simulated": True,
            "classification": "CONFIDENTIAL",
        }
    )
