"""Deterministic, read-only simulated pump and gate status source for Demo B (SIM-2).

Fixed Facilities with no wall clock and no I/O: no pump SCADA connector and no operation that
starts, stops, opens or closes anything. A Scenario changes a Facility's power in process
through ``set_power``; operating a real pump or gate is an L1 Command Package (ADR-0006).
"""

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Final, Literal

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from fieldloop_common.generated_mock_pumps import MockPumpsStatus

from fieldloop_simulator.mock_http import Rfc3339, app_state, known_query_only, problem
from fieldloop_simulator.mock_signals import Classification, Observation
from fieldloop_simulator.organisation import DEMO_ORG_ID, require_org_id
from fieldloop_simulator.scenario_overrides import HeldValues

SOURCE_ID = "mock-pumps"
CLASSIFICATION: Classification = "CONFIDENTIAL"
# The Scenario time a read uses when it names none: the start of the Bangkok storm simulation,
# so a bare read is reproducible (SIM-5).
DEFAULT_AS_OF: Final = datetime(2026, 10, 12, tzinfo=UTC)

PowerStatus = Literal["available", "lost"]


@dataclass(frozen=True)
class Facility:
    """One synthetic pump or gate and the state it is in while it has power."""

    facility_type: Literal["pump", "gate"]
    zone_code: str
    operating_state: str


# Authored values, not the state of a real Facility. Each is a Facility in
# ``data/synthetic/bangkok/facilities.geojson``; a test keeps the codes, types and zones in
# step, because the simulator image does not carry ``data/``.
FACILITIES: Mapping[str, Facility] = {
    "P-1": Facility("pump", "Z3", "running"),
    "P-2": Facility("pump", "Z4", "running"),
    "P-3": Facility("pump", "Z3", "running"),
    "G-1": Facility("gate", "Z3", "closed"),
    "G-2": Facility("gate", "Z4", "closed"),
}


class SimulatedPumps:
    def __init__(self, *, org_id: str = DEMO_ORG_ID) -> None:
        self.org_id = require_org_id(org_id)
        self._power: HeldValues[PowerStatus] = HeldValues()

    def set_power(self, asset_code: str, *, start: datetime, status: PowerStatus) -> None:
        """Hold a Facility's power at ``status`` from ``start`` on, until the next reset."""
        if asset_code not in FACILITIES:
            raise KeyError(asset_code)
        if status not in ("available", "lost"):
            raise ValueError("Power status must be available or lost")
        self._power.hold(asset_code, start=start, value=status)

    def reset(self) -> None:
        """Forget every power change, so the next run starts from the baseline (SIM-5)."""
        self._power.reset()

    def power_at(self, asset_code: str, at: datetime) -> PowerStatus:
        if asset_code not in FACILITIES:
            raise KeyError(asset_code)
        return self._power.at(asset_code, at) or "available"

    def operating_state_at(self, asset_code: str, at: datetime) -> str:
        """A pump without power is stopped; a gate stays where it was."""
        facility = FACILITIES[asset_code]
        if facility.facility_type == "pump" and self.power_at(asset_code, at) == "lost":
            return "stopped"
        return facility.operating_state

    def observe(self, asset_code: str, at: datetime) -> Observation:
        """The power status a Scenario publishes as a Signal; the tag names the Facility."""
        facility = FACILITIES[asset_code]
        return Observation(
            source=SOURCE_ID,
            classification=CLASSIFICATION,
            tag=f"{asset_code}.{facility.facility_type}.power",
            value=self.power_at(asset_code, at),
            observed_at=at,
            payload={
                "assetCode": asset_code,
                "facilityType": facility.facility_type,
                "zoneCode": facility.zone_code,
                "operatingState": self.operating_state_at(asset_code, at),
                "label": "SIMULATION",
            },
        )

    def status(self, asset_code: str, as_of: datetime) -> MockPumpsStatus:
        """The status as the API serves it. ``KeyError`` for an unknown pump or gate."""
        facility = FACILITIES[asset_code]
        return MockPumpsStatus.model_validate(
            {
                "assetCode": asset_code,
                "facilityType": facility.facility_type,
                "zoneCode": facility.zone_code,
                "operatingState": self.operating_state_at(asset_code, as_of),
                "powerStatus": self.power_at(asset_code, as_of),
                "observedAt": as_of,
                "orgId": self.org_id,
                "label": "SIMULATION",
                "simulated": True,
                "classification": CLASSIFICATION,
            }
        )


router = APIRouter(
    prefix="/mock/pumps", tags=["mock-pumps"], dependencies=[Depends(known_query_only)]
)

get_pumps = app_state("pumps", SimulatedPumps)


@router.get("/{id}/status", response_model=MockPumpsStatus)
def read_status(
    id: str,
    pumps: Annotated[SimulatedPumps, Depends(get_pumps)],
    as_of: Annotated[Rfc3339, Query(alias="asOf")] = DEFAULT_AS_OF,
) -> MockPumpsStatus | JSONResponse:
    try:
        return pumps.status(id, as_of)
    except KeyError:
        return problem(404, "Unknown pump or gate", "not_found")
