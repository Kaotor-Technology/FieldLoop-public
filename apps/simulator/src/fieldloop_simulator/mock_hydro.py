"""Deterministic, read-only simulated rain, canal level and tide sources for Demo B (SIM-2).

Every reading is a pure function of kind and Scenario time, plus any Scenario override. There
is no wall clock, no randomness, no I/O and no live public API (PRD Q49). The HTTP side is
read-only; a Scenario changes a reading in process through ``add_override``.
"""

import math
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from itertools import pairwise
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from fieldloop_common.generated_mock_hydro import MockHydroReading

from fieldloop_simulator.bangkok_storm import LABEL, SIMULATION_STARTS_AT
from fieldloop_simulator.mock_http import Rfc3339, app_state, known_query_only, problem
from fieldloop_simulator.mock_signals import Classification, Observation
from fieldloop_simulator.organisation import DEMO_ORG_ID, require_org_id
from fieldloop_simulator.scenario_overrides import HeldValues

SOURCE_ID = "mock-hydro"
CLASSIFICATION: Classification = "CONFIDENTIAL"
# The units the response schema allows: mm/h for rain, m for a level.
Unit = Literal["mm/h", "m"]
ACCUMULATION_TAG = "rain.accumulation.24h"
ACCUMULATION_UNIT = "mm"
ACCUMULATION_WINDOW = timedelta(hours=24)

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
_WAVE_PERIOD = timedelta(hours=12)


@dataclass(frozen=True)
class SensorProfile:
    """Illustrative simulated behaviour of one sensor; these are not measurements or forecasts.

    ``swing`` is the half-range of a 12 hour triangle wave around ``base``; zero is flat.
    ``minimum`` is the lowest value the quantity can take, where it has one.
    """

    asset_code: str
    zone_code: str
    quantity: str
    unit: Unit
    base: float
    swing: float = 0.0
    minimum: float | None = None


# Authored values. Each sensor is a Facility in ``data/synthetic/bangkok/facilities.geojson``; a
# test keeps the codes and zones in step, because the simulator image does not carry ``data/``.
SENSOR_PROFILES: Mapping[str, SensorProfile] = {
    "rain": SensorProfile("S-R1", "Z3", "rain.rate", "mm/h", base=0.0, minimum=0.0),
    "level": SensorProfile("S-L1", "Z3", "water.level", "m", base=0.6),
    "tide": SensorProfile("S-T1", "Z4", "tide.level", "m", base=0.9, swing=0.6),
}


def signal_payload(kind: str, *, accumulation: bool = False) -> dict[str, object]:
    """What a Signal of this source says about its sensor, whoever publishes the Signal."""
    profile = SENSOR_PROFILES[kind]
    payload: dict[str, object] = {
        "assetCode": profile.asset_code,
        "zone": profile.zone_code,
        "kind": kind,
    }
    if accumulation:
        payload["windowSeconds"] = int(ACCUMULATION_WINDOW.total_seconds())
    payload["label"] = LABEL
    return payload


class SimulatedHydro:
    def __init__(self, *, org_id: str = DEMO_ORG_ID) -> None:
        self.org_id = require_org_id(org_id)
        self._overrides: HeldValues[float] = HeldValues()

    def add_override(self, kind: str, *, start: datetime, value: float) -> None:
        """Hold a kind at ``value`` from ``start`` on, until the next reset."""
        profile = SENSOR_PROFILES[kind]
        # bool is an int in Python, and True is not a reading.
        if isinstance(value, bool) or not math.isfinite(value):
            raise ValueError("Override value must be a finite number")
        if profile.minimum is not None and value < profile.minimum:
            raise ValueError("Override value is below what the sensor can read")
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
        phase = ((at - _EPOCH) % _WAVE_PERIOD) / _WAVE_PERIOD
        return round(profile.base + profile.swing * (4 * abs(phase - 0.5) - 1), 3)

    def observe(self, kind: str, at: datetime) -> Observation:
        """The reading a Scenario publishes as a Signal; the payload names the sensor."""
        profile = SENSOR_PROFILES[kind]
        return Observation(
            source=SOURCE_ID,
            classification=CLASSIFICATION,
            # The tag of the signal.v1 examples and the flood pack rules, which match it exactly.
            tag=profile.quantity,
            value=self.value_at(kind, at),
            observed_at=at,
            unit=profile.unit,
            subject=profile.asset_code,
            payload=signal_payload(kind),
        )

    def rain_accumulation(self, at: datetime) -> float:
        """Rainfall in mm over the 24 hours that end at ``at``.

        The rain rate is flat between the starts of its overrides (its baseline has no wave), so
        each stretch of the window adds its rate times its length; nothing is sampled.
        """
        if at.tzinfo is None:
            raise ValueError("Reading times need a timezone")
        window_start = at - ACCUMULATION_WINDOW
        inside = [start for start in self._overrides.starts("rain") if window_start < start < at]
        edges = [window_start, *inside, at]
        hours = timedelta(hours=1)
        total = sum(
            self.value_at("rain", begin) * ((end - begin) / hours) for begin, end in pairwise(edges)
        )
        # Rounded only to shed float noise, far below what a rule threshold can tell apart.
        return round(total, 6)

    def observe_rain_accumulation(self, at: datetime) -> Observation:
        """The 24 hour rainfall a Scenario publishes as a Signal.

        It is what the flood pack rule ``rainfall-needs-fresh-evidence`` matches exactly:
        ``mock-hydro``, ``rain.accumulation.24h``, unit ``mm``.
        """
        profile = SENSOR_PROFILES["rain"]
        return Observation(
            source=SOURCE_ID,
            classification=CLASSIFICATION,
            tag=ACCUMULATION_TAG,
            value=self.rain_accumulation(at),
            observed_at=at,
            unit=ACCUMULATION_UNIT,
            subject=profile.asset_code,
            payload=signal_payload("rain", accumulation=True),
        )

    def read(self, kind: str, as_of: datetime) -> MockHydroReading:
        """The reading as the API serves it. ``KeyError`` for an unknown kind."""
        profile = SENSOR_PROFILES[kind]
        return MockHydroReading.model_validate(
            {
                "kind": kind,
                "assetCode": profile.asset_code,
                "zoneCode": profile.zone_code,
                "value": self.value_at(kind, as_of),
                "unit": profile.unit,
                "observedAt": as_of,
                "orgId": self.org_id,
                "label": LABEL,
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
    as_of: Annotated[Rfc3339, Query(alias="asOf")] = SIMULATION_STARTS_AT,
) -> MockHydroReading | JSONResponse:
    try:
        return hydro.read(kind, as_of)
    except KeyError:
        return problem(404, "Unknown hydrology source", "not_found")
