"""Deterministic, read-only simulated rain, canal level and tide sources for Demo B (SIM-2).

Every reading is a pure function of kind and Scenario time, plus any Scenario override. There
is no wall clock, no randomness, no I/O and no live public API (PRD Q49). The HTTP side is
read-only; a Scenario changes a reading in process through ``add_override``.
"""

import math
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated, Final

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from fieldloop_common.generated_mock_hydro import MockHydroReading

from fieldloop_simulator.mock_http import Rfc3339, app_state, known_query_only, problem
from fieldloop_simulator.mock_signals import Classification, Observation
from fieldloop_simulator.organisation import DEMO_ORG_ID, require_org_id
from fieldloop_simulator.scenario_overrides import HeldValues

SOURCE_ID = "mock-hydro"
CLASSIFICATION: Classification = "CONFIDENTIAL"
# The Scenario time a read uses when it names none: the start of the Bangkok storm simulation,
# so a bare read is reproducible (SIM-5).
DEFAULT_AS_OF: Final = datetime(2026, 10, 12, tzinfo=UTC)

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


@dataclass(frozen=True)
class SensorProfile:
    """Illustrative simulated behaviour of one sensor; these are not measurements or forecasts.

    ``swing`` is the half-range of a triangle wave of ``period`` around ``base``; zero is flat.
    """

    sensor_code: str
    zone_code: str
    tag: str
    unit: str
    base: float
    swing: float = 0.0
    period: timedelta = timedelta(hours=12)


# Authored values. Each sensor is a Facility in ``data/synthetic/bangkok/facilities.geojson``; a
# test keeps the codes and zones in step, because the simulator image does not carry ``data/``.
SENSOR_PROFILES: Mapping[str, SensorProfile] = {
    "rain": SensorProfile("S-R1", "Z3", "rain.rate", "mm/h", base=0.0),
    "level": SensorProfile("S-L1", "Z3", "water.level", "m", base=0.6),
    "tide": SensorProfile("S-T1", "Z4", "tide.level", "m", base=0.9, swing=0.6),
}


class SimulatedHydro:
    def __init__(self, *, org_id: str = DEMO_ORG_ID) -> None:
        self.org_id = require_org_id(org_id)
        self._overrides: HeldValues[float] = HeldValues()

    def add_override(self, kind: str, *, start: datetime, value: float) -> None:
        """Hold a kind at ``value`` from ``start`` on, until the next reset."""
        if kind not in SENSOR_PROFILES:
            raise KeyError(kind)
        if not math.isfinite(value):
            raise ValueError("Override value must be finite")
        self._overrides.hold(kind, start=start, value=float(value))

    def reset(self) -> None:
        """Forget every override, so the next run starts from the baseline (SIM-5)."""
        self._overrides.reset()

    def value_at(self, kind: str, at: datetime) -> float:
        profile = SENSOR_PROFILES[kind]
        held = self._overrides.at(kind, at)
        if held is not None:
            return held
        # A triangle wave keeps this to correctly rounded IEEE operations, so it is identical
        # across platforms (a sine would depend on the C library).
        phase = ((at - _EPOCH) % profile.period) / profile.period
        return round(profile.base + profile.swing * (4 * abs(phase - 0.5) - 1), 3)

    def observe(self, kind: str, at: datetime) -> Observation:
        """The reading a Scenario publishes as a Signal; the tag names the sensor."""
        profile = SENSOR_PROFILES[kind]
        return Observation(
            source=SOURCE_ID,
            classification=CLASSIFICATION,
            tag=f"{profile.sensor_code}.{profile.tag}",
            value=self.value_at(kind, at),
            observed_at=at,
            unit=profile.unit,
            payload={
                "assetCode": profile.sensor_code,
                "zoneCode": profile.zone_code,
                "kind": kind,
                "label": "SIMULATION",
            },
        )

    def read(self, kind: str, as_of: datetime) -> MockHydroReading:
        """The reading as the API serves it. ``KeyError`` for an unknown kind."""
        profile = SENSOR_PROFILES[kind]
        return MockHydroReading.model_validate(
            {
                "kind": kind,
                "sensorCode": profile.sensor_code,
                "zoneCode": profile.zone_code,
                "value": self.value_at(kind, as_of),
                "unit": profile.unit,
                "observedAt": as_of,
                "orgId": self.org_id,
                "label": "SIMULATION",
                "simulated": True,
                "classification": CLASSIFICATION,
            }
        )


router = APIRouter(
    prefix="/mock/hydro", tags=["mock-hydro"], dependencies=[Depends(known_query_only)]
)

get_hydro = app_state("hydro", SimulatedHydro)


@router.get("/{kind}", response_model=MockHydroReading)
def read_kind(
    kind: str,
    hydro: Annotated[SimulatedHydro, Depends(get_hydro)],
    as_of: Annotated[Rfc3339, Query(alias="asOf")] = DEFAULT_AS_OF,
) -> MockHydroReading | JSONResponse:
    try:
        return hydro.read(kind, as_of)
    except KeyError:
        return problem(404, "Unknown hydrology source", "not_found")
