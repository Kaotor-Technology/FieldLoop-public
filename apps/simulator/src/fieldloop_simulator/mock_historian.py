"""Deterministic, read-only synthetic SCADA historian for Demo A (SIM-2).

Every value is a pure function of tag, timestamp and seed, plus any Scenario override. There is
no wall clock, no randomness and no I/O, so a fixed seed reproduces a run (SIM-5). The HTTP side
is read-only; a Scenario changes the series in process through ``add_override``.
"""

import hashlib
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from fieldloop_common.generated_mock_historian import MockHistorianSeries

from fieldloop_simulator.mock_http import Rfc3339, app_state, known_query_only, problem
from fieldloop_simulator.mock_signals import Classification, Observation
from fieldloop_simulator.organisation import DEMO_ORG_ID, require_org_id
from fieldloop_simulator.scenario_overrides import HeldNumbers

SOURCE_ID = "mock-historian"
CLASSIFICATION: Classification = "CONFIDENTIAL"
DEMO_SEED = 20261018
SAMPLE_INTERVAL = timedelta(seconds=60)
MAX_WINDOW = timedelta(hours=24)

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
_DAY_SECONDS = 86_400


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


class SimulatedHistorian:
    def __init__(self, *, seed: int = DEMO_SEED, org_id: str = DEMO_ORG_ID) -> None:
        self.seed = seed
        self.org_id = require_org_id(org_id)
        self._overrides = HeldNumbers()

    def profile(self, tag: str) -> TagProfile:
        return TAG_PROFILES[tag]

    def add_override(self, tag: str, *, start: datetime, value: float) -> None:
        """Hold a tag at ``value`` from ``start`` on, until the next reset."""
        if tag not in TAG_PROFILES:
            raise KeyError(tag)
        self._overrides.hold(tag, start=start, value=value)

    def reset(self, seed: int | None = None) -> None:
        """Forget every override, and take a new seed for the next run if one is given (SIM-5)."""
        self._overrides.reset()
        if seed is not None:
            self.seed = seed

    def value_at(self, tag: str, at: datetime) -> float:
        held = self._overrides.at(tag, at)
        if held is not None:
            return held
        profile = TAG_PROFILES[tag]
        second = (at - _EPOCH) // timedelta(seconds=1)
        # A triangle wave and a hash keep this to correctly rounded IEEE operations, so it is
        # identical across platforms (a sine would depend on the C library).
        wave = 4 * abs((second % _DAY_SECONDS) / _DAY_SECONDS - 0.5) - 1
        digest = hashlib.sha256(f"{self.seed}|{tag}|{second}".encode()).digest()
        jitter = int.from_bytes(digest[:8], "big") / 2**64
        return round(profile.base + profile.swing * wave + profile.noise * (2 * jitter - 1), 3)

    def observe(self, tag: str, at: datetime) -> Observation:
        """The reading a Scenario publishes as a Signal; source detail goes in the payload."""
        return Observation(
            source=SOURCE_ID,
            classification=CLASSIFICATION,
            tag=tag,
            value=self.value_at(tag, at),
            observed_at=at,
            unit=TAG_PROFILES[tag].unit,
            payload={"assetCode": "DL-01", "label": "SYNTHETIC", "quality": "good"},
        )

    def read(self, tag: str, start: datetime, end: datetime) -> MockHistorianSeries:
        """The series as the API serves it: samples on the UTC clock grid, ends inclusive.

        ``KeyError`` for an unknown tag and ``ValueError`` for a window that is empty, runs
        backwards or is longer than 24 hours.
        """
        profile = TAG_PROFILES[tag]
        if end <= start or end - start > MAX_WINDOW:
            raise ValueError("The window must be positive and at most 24 hours")
        first = -((_EPOCH - start) // SAMPLE_INTERVAL)
        last = (end - _EPOCH) // SAMPLE_INTERVAL
        points = [
            {
                "timestamp": at,
                "value": self.value_at(tag, at),
                "quality": "good",
            }
            for at in (_EPOCH + index * SAMPLE_INTERVAL for index in range(first, last + 1))
        ]
        return MockHistorianSeries.model_validate(
            {
                "tag": tag,
                "unit": profile.unit,
                "description": profile.description,
                "from": start,
                "to": end,
                "intervalSeconds": int(SAMPLE_INTERVAL.total_seconds()),
                "points": points,
                "total": len(points),
                "source": SOURCE_ID,
                "orgId": self.org_id,
                "assetCode": "DL-01",
                "label": "SYNTHETIC",
                "simulated": True,
                "classification": CLASSIFICATION,
            }
        )


router = APIRouter(
    prefix="/mock/historian", tags=["mock-historian"], dependencies=[Depends(known_query_only)]
)


get_historian = app_state("historian", SimulatedHistorian)


@router.get("/tags/{tag}", response_model=MockHistorianSeries)
def read_tag(
    tag: str,
    start: Annotated[Rfc3339, Query(alias="from")],
    end: Annotated[Rfc3339, Query(alias="to")],
    historian: Annotated[SimulatedHistorian, Depends(get_historian)],
) -> MockHistorianSeries | JSONResponse:
    try:
        return historian.read(tag, start, end)
    except KeyError:
        return problem(404, "Unknown historian tag", "not_found")
    except ValueError:
        return problem(400, "Invalid historian window", "validation_failed")
