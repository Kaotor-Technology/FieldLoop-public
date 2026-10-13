"""Deterministic, read-only simulated pump and gate status source for Demo B (SIM-2).

Fixed Facilities with no wall clock and no I/O: no pump SCADA connector and no operation that
starts, stops, opens or closes anything. A Scenario changes a Facility's power in process
through ``set_power``; operating a real pump or gate is an L1 Command Package (ADR-0006).
"""

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Literal, get_args

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from fieldloop_common.generated_mock_pumps import MockPumpsStatus

from fieldloop_simulator.bangkok_storm import LABEL, SIMULATION_STARTS_AT
from fieldloop_simulator.mock_http import Rfc3339, app_state, known_query_only, problem
from fieldloop_simulator.mock_signals import Classification, Observation
from fieldloop_simulator.organisation import DEMO_ORG_ID, require_org_id
from fieldloop_simulator.scenario_overrides import HeldValues, RunState

SOURCE_ID = "mock-pumps"
CLASSIFICATION: Classification = "CONFIDENTIAL"

FacilityType = Literal["pump", "gate"]
PowerStatus = Literal["available", "lost"]
OperatingState = Literal["running", "stopped", "open", "closed"]
# The states each type of Facility can be in, as the response schema pairs them.
OPERATING_STATES: Mapping[FacilityType, tuple[OperatingState, ...]] = {
    "pump": ("running", "stopped"),
    "gate": ("open", "closed"),
}


@dataclass(frozen=True)
class PumpOrGate:
    """One synthetic pump or gate and the state it is in while it has power."""

    facility_type: FacilityType
    zone_code: str
    operating_state: OperatingState

    def __post_init__(self) -> None:
        if self.operating_state not in OPERATING_STATES[self.facility_type]:
            raise ValueError(f"A {self.facility_type} cannot be {self.operating_state}")


# Authored values, not the state of a real Facility. Each is a Facility in
# ``data/synthetic/bangkok/facilities.geojson``; a test keeps the codes, types and zones in
# step, because the simulator image does not carry ``data/``.
PUMPS_AND_GATES: Mapping[str, PumpOrGate] = {
    "P-1": PumpOrGate("pump", "Z3", "running"),
    "P-2": PumpOrGate("pump", "Z4", "running"),
    "P-3": PumpOrGate("pump", "Z3", "running"),
    "G-1": PumpOrGate("gate", "Z3", "closed"),
    "G-2": PumpOrGate("gate", "Z4", "closed"),
}


POWER_UNIT = "state"


def power_tag(asset_code: str) -> str:
    """The Signal tag of a pump's or gate's power status: ``pump.power`` or ``gate.power``."""
    return f"{_known(asset_code).facility_type}.power"


def operating_state(asset_code: str, status: PowerStatus) -> OperatingState:
    """A pump without power is stopped; a gate stays where it was."""
    facility = _known(asset_code)
    if facility.facility_type == "pump" and status == "lost":
        return "stopped"
    return facility.operating_state


def signal_payload(asset_code: str, status: PowerStatus) -> dict[str, object]:
    """What a Signal of this source says about its pump or gate, whoever publishes the Signal."""
    facility = _known(asset_code)
    return {
        "assetCode": asset_code,
        "facilityType": facility.facility_type,
        "zone": facility.zone_code,
        "operatingState": operating_state(asset_code, status),
        "label": LABEL,
    }


def _known(asset_code: str) -> PumpOrGate:
    """The pump or gate of that code. ``KeyError`` for any other code."""
    return PUMPS_AND_GATES[asset_code]


def _checked(asset_code: str, status: PowerStatus) -> PowerStatus:
    """The status as a power change holds it. ``KeyError`` or ``ValueError`` if it cannot."""
    _known(asset_code)
    if status not in get_args(PowerStatus):
        raise ValueError("Power status must be available or lost")
    return status


def _power(held: HeldValues[PowerStatus], asset_code: str, at: datetime) -> PowerStatus:
    """The power of a pump or gate at a time, given what a run holds."""
    _known(asset_code)
    return held.at(asset_code, at) or "available"


class SimulatedPumps:
    """The ``mock-pumps`` source: the pumps and the gates of the drainage zones."""

    def __init__(self, *, org_id: str = DEMO_ORG_ID) -> None:
        self.org_id = require_org_id(org_id)
        self._run: RunState[PowerStatus] = RunState(HeldValues(), SIMULATION_STARTS_AT)

    @property
    def clock(self) -> datetime:
        """The Scenario time a read uses when it names none.

        The start of the simulation, or the clock of the committed run once the Scenario player
        has restored one.
        """
        return self._run.clock

    def set_power(self, asset_code: str, *, start: datetime, status: PowerStatus) -> None:
        """Hold a Facility's power at ``status`` from ``start`` on, until the next reset."""
        self._run.held.hold(asset_code, start=start, value=_checked(asset_code, status))

    def reset(self) -> None:
        """Forget every power change and the run's clock: the baseline of the next run (SIM-5)."""
        self._run = RunState(HeldValues(), SIMULATION_STARTS_AT)

    def restore(
        self, changes: Iterable[tuple[str, datetime, PowerStatus]], *, clock: datetime
    ) -> None:
        """Replace every power change and the clock with those of a run, in one step.

        Each change is ``(asset code, start, status)`` and is held to the rules of
        ``set_power``. If one is refused, nothing changes.
        """
        held = HeldValues.of(
            (asset_code, start, _checked(asset_code, status))
            for asset_code, start, status in changes
        )
        self._run = RunState(held, clock)

    def power_at(self, asset_code: str, at: datetime) -> PowerStatus:
        return _power(self._run.held, asset_code, at)

    def operating_state_at(self, asset_code: str, at: datetime) -> OperatingState:
        return operating_state(asset_code, self.power_at(asset_code, at))

    def observe(self, asset_code: str, at: datetime) -> Observation:
        """The power status a Scenario publishes as a Signal; the payload names the Facility.

        A pump's Signal is what the flood pack rule ``pump-power-lost`` matches exactly:
        ``mock-pumps``, ``pump.power``, ``eq lost``, unit ``state``.
        """
        status = self.power_at(asset_code, at)
        return Observation(
            source=SOURCE_ID,
            classification=CLASSIFICATION,
            tag=power_tag(asset_code),
            value=status,
            observed_at=at,
            unit=POWER_UNIT,
            # Two pumps share a tag, so the Facility takes part in the Signal's identity.
            subject=asset_code,
            payload=signal_payload(asset_code, status),
        )

    def status(self, asset_code: str, as_of: datetime | None = None) -> MockPumpsStatus:
        """The status as the API serves it, as of the clock when no time is given.

        ``KeyError`` for an unknown pump or gate.
        """
        facility = _known(asset_code)
        run = self._run  # read once, so the time and the status are of one run
        as_of = as_of or run.clock
        power = _power(run.held, asset_code, as_of)
        return MockPumpsStatus.model_validate(
            {
                "assetCode": asset_code,
                "facilityType": facility.facility_type,
                "zoneCode": facility.zone_code,
                "operatingState": operating_state(asset_code, power),
                "powerStatus": power,
                "observedAt": as_of,
                "orgId": self.org_id,
                "label": LABEL,
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
    as_of: Annotated[Rfc3339 | None, Query(alias="asOf")] = None,
) -> MockPumpsStatus | JSONResponse:
    try:
        return pumps.status(id, as_of)
    except KeyError:
        return problem(404, "Unknown pump or gate", "not_found")
