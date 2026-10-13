"""Request-driven service: durable commands, bounded publication and read-only source hydration."""

import asyncio
import hashlib
import threading
import uuid
from collections.abc import Callable
from contextlib import AbstractContextManager
from typing import Protocol

from fieldloop_common.generated_simulation import PlayerCommand, RunCreate

from fieldloop_simulator.mock_historian import DEMO_SEED, SimulatedHistorian
from fieldloop_simulator.player import (
    Command,
    PlayerSnapshot,
    PlayerTransaction,
    ScenarioPlayer,
    observation,
)


class PlayerStore(Protocol):
    def transaction(self) -> AbstractContextManager[PlayerTransaction]: ...


class SimulationService:
    def __init__(
        self,
        player: ScenarioPlayer,
        store: Callable[[], PlayerStore],
        historian: SimulatedHistorian,
    ) -> None:
        self.player = player
        self.store = store
        self.historian = historian
        self._projection_lock = threading.RLock()

    def current(self, run_id: uuid.UUID | None = None) -> dict[str, object] | None:
        with self._projection_lock:
            with self.store().transaction() as tx:
                run = asyncio.run(asyncio.wait_for(self.player.read(tx, run_id), timeout=25))
                snapshot = tx.snapshot
            self._hydrate(snapshot)
            return run.model_dump(mode="json", by_alias=True) if run else None

    def execute(
        self,
        path: str,
        key: str,
        body: RunCreate | PlayerCommand,
        run_id: uuid.UUID | None = None,
        command: Command | None = None,
    ) -> dict[str, object]:
        with self._projection_lock:
            digest = hashlib.sha256(
                body.model_dump_json(by_alias=True, exclude_unset=True).encode()
            ).hexdigest()
            command_key = hashlib.sha256(f"{path}:{key}".encode()).hexdigest()
            with self.store().transaction() as tx:
                response = tx.lookup(command_key, digest)
                if response is None:
                    if isinstance(body, RunCreate):
                        run = self.player.create(tx, body)
                    else:
                        assert command is not None and run_id is not None
                        run = asyncio.run(
                            asyncio.wait_for(
                                self.player.command(tx, run_id, command, body), timeout=25
                            )
                        )
                    response = run.model_dump(mode="json", by_alias=True)
                    tx.remember(command_key, digest, response)
                snapshot = tx.snapshot
            self._hydrate(snapshot)
            return response

    def hydrate_sources(self) -> None:
        with self._projection_lock:
            with self.store().transaction() as tx:
                snapshot = tx.snapshot
            self._hydrate(snapshot)

    def _hydrate(self, snapshot: PlayerSnapshot | None) -> None:
        # Rebuild from the committed index, including after a cold start or retry.
        self.historian.reset(snapshot.run.seed if snapshot else DEMO_SEED)
        if snapshot:
            for event in snapshot.scenario.events[: snapshot.run.next_event_index]:
                if event.source == "mock-historian":
                    reading = observation(snapshot, event)
                    if isinstance(reading.value, (float, int)) and not isinstance(
                        reading.value, bool
                    ):
                        self.historian.add_override(
                            event.tag, start=reading.observed_at, value=float(reading.value)
                        )
