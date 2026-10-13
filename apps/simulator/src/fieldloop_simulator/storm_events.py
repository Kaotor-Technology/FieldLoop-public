"""What a Scenario event of a Demo B source must be, and what it does to that source (SIM-1, SIM-2).

A Scenario names a source's tag, unit and Asset. The Scenario validator refuses an event the
installed source could not have published, the player fills the Signal's payload from the
source, and the service replays applied events into the source so that reads follow a run.
"""

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
from typing import cast, get_args

from fieldloop_common.generated_scenario import Event

from fieldloop_simulator import mock_hydro, mock_pumps
from fieldloop_simulator.mock_hydro import SENSOR_PROFILES, SimulatedHydro
from fieldloop_simulator.mock_pumps import PUMPS_AND_GATES, PowerStatus, SimulatedPumps

_SOURCES = (mock_hydro.SOURCE_ID, mock_pumps.SOURCE_ID)
_KIND_OF_TAG = {profile.quantity: kind for kind, profile in SENSOR_PROFILES.items()}
_RAIN_SENSOR = SENSOR_PROFILES["rain"].asset_code
# Far beyond any rain rate or level, and small enough that a 24 hour sum stays finite.
_LARGEST_READING = 1e6


def _is_number(value: object) -> bool:
    return isinstance(value, (float, int)) and not isinstance(value, bool)


def _is_rainfall(event: Event) -> bool:
    return event.source == mock_hydro.SOURCE_ID and event.tag == mock_hydro.ACCUMULATION_TAG


def is_derived_rainfall(event: Event) -> bool:
    """Whether the event is the 24 hour rainfall with no value of its own, which is summed.

    A run pinned before that rule may hold one with an authored number; it stays as authored.
    """
    return _is_rainfall(event) and event.value is None


def check(event: Event) -> tuple[str, str] | None:
    """Where and why an event is not one its source publishes, or ``None``.

    The first member is a JSON pointer below the event, such as ``/unit``.
    """
    if event.source == mock_hydro.SOURCE_ID:
        return _check_hydro(event)
    if event.source == mock_pumps.SOURCE_ID:
        return _check_pumps(event)
    return None


def _check_hydro(event: Event) -> tuple[str, str] | None:
    if _is_rainfall(event):
        if event.value is not None:
            return "/value", "the 24 hour rainfall is derived from the rain events; write null"
        unit, sensor = mock_hydro.ACCUMULATION_UNIT, _RAIN_SENSOR
    else:
        kind = _KIND_OF_TAG.get(event.tag)
        if kind is None:
            return "/tag", "unknown installed hydrology tag"
        profile = SENSOR_PROFILES[kind]
        if not _is_number(event.value):
            return "/value", "hydrology readings must be numeric"
        reading, noise = float(cast(float, event.value)), event.noise_amplitude or 0
        if profile.minimum is not None and reading - noise < profile.minimum:
            return "/value", "the value, less its noise, is below what the sensor can read"
        if abs(reading) + noise > _LARGEST_READING:
            return "/value", "the value, with its noise, is beyond what the sensor can read"
        unit, sensor = profile.unit, profile.asset_code
    if event.unit != unit:
        return "/unit", "unit differs from the source API"
    if (event.target.kind, event.target.id) != ("asset", sensor):
        return "/target", "target is not the sensor that reports this tag"
    return None


def _check_pumps(event: Event) -> tuple[str, str] | None:
    if event.target.kind != "asset" or event.target.id not in PUMPS_AND_GATES:
        return "/target", "unknown pump or gate"
    if event.tag != mock_pumps.power_tag(event.target.id):
        return "/tag", "tag differs from the source API for this pump or gate"
    if event.value not in get_args(PowerStatus):
        return "/value", "power status must be available or lost"
    if event.unit != mock_pumps.POWER_UNIT:
        return "/unit", "unit differs from the source API"
    return None


@dataclass(frozen=True)
class Stated:
    """A valid event of a Demo B source as the source states it, checked once for every caller."""

    # The Asset the Signal is about. It is the Signal's identity, as in the source's own
    # ``observe()``, so one reading has one ``id`` whether the player or the source publishes it.
    asset_code: str
    payload: dict[str, object]
    # Whether the 24 hour rainfall sums the event.
    rain_rate: bool
    # Whether a read of the source changes once the event is applied.
    holds_state: bool


def stated(event: Event) -> Stated | None:
    """What the source says of a valid event; ``None`` for another source or a refused event."""
    if event.source not in _SOURCES or check(event) is not None:
        return None
    if _is_rainfall(event):
        return Stated(event.target.id, mock_hydro.rainfall_payload(), False, False)
    if event.source == mock_hydro.SOURCE_ID:
        kind = _KIND_OF_TAG[event.tag]
        return Stated(event.target.id, mock_hydro.signal_payload(kind), kind == "rain", True)
    status = cast(PowerStatus, event.value)
    return Stated(event.target.id, mock_pumps.signal_payload(event.target.id, status), False, True)


def rainfall(rates: Iterable[tuple[datetime, float]], at: datetime) -> float:
    """Rainfall in mm over the 24 hours that end at ``at``, given when each rain rate began."""
    hydro = SimulatedHydro()
    for start, rate in rates:
        hydro.add_override("rain", start=start, value=rate)
    return hydro.rain_accumulation(at)


def apply(
    event: Event, value: object, at: datetime, hydro: SimulatedHydro, pumps: SimulatedPumps
) -> None:
    """Make the source's reads show an applied event from ``at`` on.

    Only for an event that holds state (``Stated.holds_state``). An event the source cannot
    hold is the caller's to leave out: a run pinned before these rules existed must not turn
    every read of the source into an error.
    """
    if event.source == mock_hydro.SOURCE_ID:
        hydro.add_override(_KIND_OF_TAG[event.tag], start=at, value=float(cast(float, value)))
    else:
        pumps.set_power(event.target.id, start=at, status=cast(PowerStatus, value))
