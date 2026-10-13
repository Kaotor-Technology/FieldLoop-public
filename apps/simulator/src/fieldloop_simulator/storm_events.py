"""What a Scenario event of a Demo B source must be, and what it does to that source (SIM-1, SIM-2).

A Scenario names a source's tag, unit and Asset. The Scenario validator refuses an event the
installed source could not have published, the player fills the Signal's payload from the
source, and the service replays applied events into the source so that reads follow a run.
"""

from collections.abc import Iterable
from datetime import datetime
from typing import get_args

from fieldloop_common.generated_scenario import Event

from fieldloop_simulator import mock_hydro, mock_pumps
from fieldloop_simulator.mock_hydro import SENSOR_PROFILES, SimulatedHydro
from fieldloop_simulator.mock_pumps import PUMPS_AND_GATES, PowerStatus, SimulatedPumps

_SOURCES = (mock_hydro.SOURCE_ID, mock_pumps.SOURCE_ID)
_KIND_OF_TAG = {profile.quantity: kind for kind, profile in SENSOR_PROFILES.items()}
_RAIN_SENSOR = SENSOR_PROFILES["rain"].asset_code


def _is_number(value: object) -> bool:
    return isinstance(value, (float, int)) and not isinstance(value, bool)


def is_derived_rainfall(event: Event) -> bool:
    """Whether the event is the 24 hour rainfall, which the source sums and no author writes."""
    return event.source == mock_hydro.SOURCE_ID and event.tag == mock_hydro.ACCUMULATION_TAG


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
    if is_derived_rainfall(event):
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
        lowest = float(event.value) - (event.noise_amplitude or 0)  # type: ignore[arg-type]
        if profile.minimum is not None and lowest < profile.minimum:
            return "/value", "the value, less its noise, is below what the sensor can read"
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


def subject(event: Event) -> str | None:
    """What a valid event's Signal is about: the Asset, as the source's own ``observe()`` has it.

    The Asset takes part in the Signal ``id``, so one reading has one ``id`` whether the player
    or the source publishes it. ``None`` for other sources and for an event that is not valid.
    """
    return event.target.id if event.source in _SOURCES and check(event) is None else None


def payload(event: Event, value: object) -> dict[str, object]:
    """The source's own payload for the Signal of a valid event; empty for other sources."""
    if check(event) is not None:
        return {}
    if is_derived_rainfall(event):
        return mock_hydro.signal_payload("rain", accumulation=True)
    if event.source == mock_hydro.SOURCE_ID:
        return mock_hydro.signal_payload(_KIND_OF_TAG[event.tag])
    if event.source == mock_pumps.SOURCE_ID and value in get_args(PowerStatus):
        return mock_pumps.signal_payload(event.target.id, value)  # type: ignore[arg-type]
    return {}


def rainfall(rates: Iterable[tuple[datetime, float]], at: datetime) -> float:
    """Rainfall in mm over the 24 hours that end at ``at``, given when each rain rate began."""
    hydro = SimulatedHydro()
    for start, rate in rates:
        # A rate cannot be negative; the validator keeps a Scenario's noise from making one.
        hydro.add_override("rain", start=start, value=max(rate, 0.0))
    return hydro.rain_accumulation(at)


def apply(
    event: Event, value: object, at: datetime, hydro: SimulatedHydro, pumps: SimulatedPumps
) -> None:
    """Make the source's reads show an applied event from ``at`` on.

    An event the source cannot hold is left out: a run pinned before these rules existed must
    not turn every read of the source into an error.
    """
    if check(event) is not None or is_derived_rainfall(event):
        return
    if event.source == mock_hydro.SOURCE_ID and _is_number(value):
        kind = _KIND_OF_TAG[event.tag]
        lowest = SENSOR_PROFILES[kind].minimum
        reading = float(value)  # type: ignore[arg-type]
        hydro.add_override(
            kind, start=at, value=reading if lowest is None else max(reading, lowest)
        )
    elif event.source == mock_pumps.SOURCE_ID and value in get_args(PowerStatus):
        pumps.set_power(event.target.id, start=at, status=value)  # type: ignore[arg-type]
