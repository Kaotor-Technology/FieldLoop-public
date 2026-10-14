"""Server clock and seeded timeline execution. Effects are simulation-only Signals (SIM-3…6)."""

import asyncio
import hashlib
import random
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal, Protocol, cast

from fieldloop_common.generated_scenario import Event, Scenario
from fieldloop_common.generated_simulation import PlayerCommand, RunCreate, SimulationRun
from pydantic import BaseModel

from fieldloop_simulator import storm_events
from fieldloop_simulator.mock_historian import CLASSIFICATION as HISTORIAN_CLASSIFICATION
from fieldloop_simulator.mock_signals import (
    Observation,
    SignalValue,
    SimulatedSignalEmitter,
    utc_text,
)

Command = Literal["play", "pause", "step", "speed", "bookmark", "reset"]


class PlayerError(ValueError):
    def __init__(self, status: int, code: str) -> None:
        self.status = status
        self.code = code
        super().__init__(code)


class PlayerSnapshot(BaseModel):
    # Internal persistence, not another wire contract. Scenario content is pinned per run.
    scenario: Scenario
    run: SimulationRun
    anchor: datetime


class PlayerTransaction(Protocol):
    snapshot: PlayerSnapshot | None

    def restore_baseline(self) -> None: ...
    def save(self, snapshot: PlayerSnapshot) -> None: ...
    def lookup(self, key: str, digest: str) -> dict[str, object] | None: ...
    def remember(self, key: str, digest: str, response: dict[str, object]) -> None: ...


@dataclass
class ScenarioPlayer:
    catalog: dict[str, Scenario]
    org_id: str
    emitter: Callable[[], SimulatedSignalEmitter]
    now: Callable[[], datetime] = lambda: datetime.now(UTC)

    def create(self, tx: PlayerTransaction, body: RunCreate) -> SimulationRun:
        if body.scenario_id not in self.catalog:
            raise PlayerError(404, "scenario_not_found")
        if tx.snapshot is not None:
            current = tx.snapshot.run
            if current.state != "ready" or current.next_event_index != 0:
                raise PlayerError(409, "reset_required")
            tx.restore_baseline()
        return self._new(tx, self.catalog[body.scenario_id], body.seed, body.speed)

    def _new(
        self, tx: PlayerTransaction, scenario: Scenario, seed: int, speed: float
    ) -> SimulationRun:
        run = SimulationRun.model_validate(
            {
                "id": str(uuid.uuid4()),
                "revision": tx.snapshot.run.revision + 1 if tx.snapshot else 1,
                "orgId": self.org_id,
                "scenarioId": scenario.id,
                "scenarioName": scenario.name,
                "seed": seed,
                "speed": speed,
                "clock": utc_text(
                    datetime.fromisoformat(scenario.starts_at.replace("Z", "+00:00"))
                ),
                "elapsedSeconds": 0,
                "durationSeconds": scenario.duration_seconds,
                "state": "ready",
                "nextEventIndex": 0,
                "eventCount": len(scenario.events),
                "simulated": True,
                "classification": classification(scenario),
                "bookmarks": [b.model_dump(by_alias=True) for b in scenario.bookmarks],
            }
        )
        tx.save(PlayerSnapshot(scenario=scenario, run=run, anchor=self.now()))
        return run

    async def read(
        self, tx: PlayerTransaction, run_id: uuid.UUID | None = None
    ) -> SimulationRun | None:
        snapshot = tx.snapshot
        if snapshot is None:
            if run_id is not None:
                raise PlayerError(404, "run_not_found")
            return None
        self._check_id(snapshot, run_id)
        await self._catch_up(snapshot)
        snapshot.run.revision += 1
        tx.save(snapshot)
        return snapshot.run

    async def command(
        self, tx: PlayerTransaction, run_id: uuid.UUID, command: Command, body: PlayerCommand
    ) -> SimulationRun:
        snapshot = tx.snapshot
        if snapshot is None:
            raise PlayerError(404, "run_not_found")
        self._check_id(snapshot, run_id)
        expected_fields = (
            {"speed"}
            if command == "speed"
            else ({"bookmark_id"} if command == "bookmark" else set())
        )
        if body.model_fields_set != expected_fields:
            raise PlayerError(400, "invalid_command_body")
        if command == "reset":
            tx.restore_baseline()
            return self._new(tx, snapshot.scenario, snapshot.run.seed, snapshot.run.speed)
        if command == "step" and snapshot.run.state not in ("ready", "paused"):
            raise PlayerError(409, "pause_required")
        if command == "bookmark" and snapshot.run.state == "playing":
            raise PlayerError(409, "pause_required")
        if command == "play" and snapshot.run.state == "finished":
            raise PlayerError(409, "reset_required")
        await self._catch_up(snapshot)
        run = snapshot.run
        if command == "play":
            run.state = "playing"
            await self._advance(snapshot, run.elapsed_seconds)
        elif command == "pause":
            if run.state != "finished":
                run.state = "paused"
        elif command == "step":
            run.state = "paused"
            target = (
                snapshot.scenario.events[run.next_event_index].at_seconds
                if (run.next_event_index < run.event_count)
                else run.duration_seconds
            )
            await self._advance(snapshot, target, max_events=1)
        elif command == "speed":
            if body.speed is None:
                raise PlayerError(400, "invalid_speed")
            run.speed = body.speed
        elif command == "bookmark":
            bookmark = next((b for b in run.bookmarks if b.id == body.bookmark_id), None)
            if bookmark is None:
                raise PlayerError(404, "bookmark_not_found")
            if bookmark.at_seconds < run.elapsed_seconds:
                scenario, seed, speed = snapshot.scenario, run.seed, run.speed
                tx.restore_baseline()
                run = self._new(tx, scenario, seed, speed)
                assert tx.snapshot is not None
                snapshot = tx.snapshot
            run.state = "paused"
            await self._advance(snapshot, bookmark.at_seconds)
        snapshot.anchor = self.now()
        run.revision += 1
        tx.save(snapshot)
        return run

    @staticmethod
    def _check_id(snapshot: PlayerSnapshot, run_id: uuid.UUID | None) -> None:
        if run_id is not None and snapshot.run.id != run_id:
            raise PlayerError(409, "run_retired")

    async def _catch_up(self, snapshot: PlayerSnapshot) -> None:
        now = self.now()
        if snapshot.run.state == "playing":
            delta = max(0.0, (now - snapshot.anchor).total_seconds())
            await self._advance(snapshot, snapshot.run.elapsed_seconds + delta * snapshot.run.speed)
        snapshot.anchor = now

    async def _advance(
        self, snapshot: PlayerSnapshot, target: float, *, max_events: int | None = None
    ) -> None:
        run = snapshot.run
        target = min(target, run.duration_seconds)
        emitter: SimulatedSignalEmitter | None = None
        emitted = 0
        while run.next_event_index < run.event_count:
            event = snapshot.scenario.events[run.next_event_index]
            if event.at_seconds > target:
                break
            emitter = emitter or self.emitter()
            result = await asyncio.wait_for(
                emitter.emit(observation(snapshot, event), run_id=run.id), timeout=10
            )
            if result.outcome != "published":
                raise PlayerError(503, "signal_quarantined")
            # A failed transaction re-emits the same IDs; consumers deduplicate (at-least-once).
            run.next_event_index += 1
            emitted += 1
            if max_events is not None and emitted >= max_events:
                break
        run.elapsed_seconds = target
        at = datetime.fromisoformat(snapshot.scenario.starts_at.replace("Z", "+00:00"))
        run.clock = utc_text(at + timedelta(seconds=target))
        if target >= run.duration_seconds and run.next_event_index == run.event_count:
            run.state = "finished"


def classification(
    scenario: Scenario,
) -> Literal["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED"]:
    # Reuse the classifications of installed sources; reserve the highest class for
    # sources whose APIs are not installed yet. A Scenario cannot downgrade a source.
    classes = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED"]
    minimums = {
        "mock-historian": HISTORIAN_CLASSIFICATION,
        # Demo B publishes all three water sensors and pumps/gates under one source each.
        "mock-hydro": "CONFIDENTIAL",
        "mock-pumps": "CONFIDENTIAL",
        "mock-patrol": "HIGHLY_RESTRICTED",
        "mock-ili": "HIGHLY_RESTRICTED",
    }
    highest = max(
        [
            classes.index(scenario.classification),
            *[
                classes.index(minimums.get(event.source, "HIGHLY_RESTRICTED"))
                for event in scenario.events
            ],
        ]
    )
    from typing import cast

    from fieldloop_simulator.mock_signals import Classification

    return cast(Classification, classes[highest])


def _starts_at(snapshot: PlayerSnapshot) -> datetime:
    return datetime.fromisoformat(snapshot.scenario.starts_at.replace("Z", "+00:00"))


def reading(snapshot: PlayerSnapshot, event: Event) -> SignalValue:
    """The value an event publishes: as authored, with its seeded noise, or derived."""
    if storm_events.is_derived_rainfall(event):
        # Summed from the rain rates before this event, so no author states a total.
        starts_at = _starts_at(snapshot)
        rates: list[tuple[datetime, float]] = []
        for item in snapshot.scenario.events:
            if item.id == event.id:
                break
            if (described := storm_events.describe(item)) and described.rain_rate:
                rate = cast(float, reading(snapshot, item))
                rates.append((starts_at + timedelta(seconds=item.at_seconds), float(rate)))
        return storm_events.rainfall(rates, starts_at + timedelta(seconds=event.at_seconds))
    value = event.value
    if event.noise_amplitude:
        assert isinstance(value, (float, int)) and not isinstance(value, bool)
        identity = (
            f"{snapshot.run.seed}:{snapshot.scenario.id}:{snapshot.scenario.version}:{event.id}"
        )
        rng = random.Random(int.from_bytes(hashlib.sha256(identity.encode()).digest(), "big"))
        value = float(value) + rng.uniform(-event.noise_amplitude, event.noise_amplitude)
    return value


def observation(snapshot: PlayerSnapshot, event: Event) -> Observation:
    value = reading(snapshot, event)
    at = _starts_at(snapshot)
    payload = dict(event.payload or {})
    described = storm_events.describe(event)
    if described:
        # A Demo B source states its own payload, so an author cannot contradict the source.
        payload.update(described.payload)
    payload.update(target=event.target.model_dump(), label="SIMULATION", sandbox=True)
    return Observation(
        source=event.source,
        classification=classification(snapshot.scenario),
        tag=event.tag,
        value=value,
        unit=event.unit,
        observed_at=at + timedelta(seconds=event.at_seconds),
        payload=payload,
        # A Demo B Signal is identified by its Asset, as the source identifies it; others by event.
        subject=described.asset_code if described else event.id,
    )
