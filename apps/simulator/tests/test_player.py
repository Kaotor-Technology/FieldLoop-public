import asyncio
import json
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import Event as ThreadEvent
from threading import Lock, RLock, Thread
from uuid import UUID

import pytest
from fieldloop_common.generated_scenario import Event
from fieldloop_common.generated_simulation import PlayerCommand, RunCreate
from fieldloop_common.memory_transport import InMemoryTransport
from fieldloop_common.signal_publisher import SignalPublisher
from fieldloop_simulator.mock_historian import SimulatedHistorian
from fieldloop_simulator.mock_signals import SimulatedSignalEmitter
from fieldloop_simulator.player import PlayerError, PlayerSnapshot, ScenarioPlayer
from fieldloop_simulator.player_service import SimulationService
from fieldloop_simulator.scenario import load_scenario


class MemoryTransaction:
    def __init__(self) -> None:
        self.snapshot: PlayerSnapshot | None = None
        self.resets = 0
        self.commands: dict[str, tuple[str, dict[str, object]]] = {}

    def restore_baseline(self) -> None:
        self.resets += 1

    def save(self, snapshot: PlayerSnapshot) -> None:
        self.snapshot = snapshot

    def lookup(self, key: str, digest: str) -> dict[str, object] | None:
        result = self.commands.get(key)
        if result is None:
            return None
        if result[0] != digest:
            raise PlayerError(409, "idempotency_key_reused")
        return result[1]

    def remember(self, key: str, digest: str, response: dict[str, object]) -> None:
        self.commands[key] = (digest, response)


class MemoryStore:
    def __init__(self) -> None:
        self.tx = MemoryTransaction()
        self._lock = RLock()

    @contextmanager
    def transaction(self) -> Iterator[MemoryTransaction]:
        import copy

        with self._lock:
            before = copy.deepcopy(self.tx)
            try:
                yield self.tx
            except Exception:
                self.tx = before
                raise


def fixture() -> tuple[ScenarioPlayer, MemoryStore, InMemoryTransport, list[datetime]]:
    scenario = load_scenario(Path(__file__).parent / "fixtures/player.json")
    transport = InMemoryTransport()
    publisher = SignalPublisher(
        transport, environment="local", org_id="test-org", simulation_only=True
    )
    emitter = SimulatedSignalEmitter(publisher, org_id="test-org")
    now = [datetime(2026, 10, 13, tzinfo=UTC)]
    player = ScenarioPlayer({scenario.id: scenario}, "test-org", lambda: emitter, lambda: now[0])
    return player, MemoryStore(), transport, now


def create(player: ScenarioPlayer, store: MemoryStore) -> None:
    player.create(store.tx, RunCreate(scenarioId="player-test", seed=42, speed=1))


def execute(player: ScenarioPlayer, store: MemoryStore, command: str, body: dict | None = None):
    assert store.tx.snapshot
    with store.transaction() as tx:
        return asyncio.run(
            player.command(
                tx, tx.snapshot.run.id, command, PlayerCommand.model_validate(body or {})
            )
        )


def test_server_clock_speed_and_pause() -> None:
    player, store, transport, now = fixture()
    create(player, store)
    execute(player, store, "play")
    assert len(transport.messages) == 1  # T+0 is emitted on play, not on create.
    now[0] += timedelta(seconds=10)
    changed = execute(player, store, "speed", {"speed": 2})
    assert changed.elapsed_seconds == 10
    now[0] += timedelta(seconds=10)
    assert execute(player, store, "pause").elapsed_seconds == 30
    now[0] += timedelta(days=1)
    assert asyncio.run(player.read(store.tx)).elapsed_seconds == 30


def test_steps_group_simultaneous_events_and_finish_at_duration() -> None:
    player, store, transport, _ = fixture()
    create(player, store)
    assert execute(player, store, "step").elapsed_seconds == 0
    assert execute(player, store, "step").elapsed_seconds == 60
    assert len(transport.messages) == 3
    assert execute(player, store, "step").state == "finished"
    with pytest.raises(PlayerError, match="reset_required"):
        execute(player, store, "play")


def test_backwards_bookmark_starts_a_new_run_and_replays_from_baseline() -> None:
    player, store, transport, _ = fixture()
    create(player, store)
    original_id = store.tx.snapshot.run.id
    first = execute(player, store, "bookmark", {"bookmarkId": "failure"})
    assert first.elapsed_seconds == 60
    assert len(transport.messages) == 3

    rewound = execute(player, store, "bookmark", {"bookmarkId": "start"})
    assert rewound.id != first.id
    assert rewound.id != original_id
    assert rewound.state == "paused"
    assert rewound.elapsed_seconds == 0
    assert rewound.next_event_index == 1
    assert store.tx.resets == 1
    messages = [json.loads(data) for _, data, _ in transport.messages]
    assert [message["simulationRunId"] for message in messages[:3]] == [str(first.id)] * 3
    assert messages[3]["simulationRunId"] == str(rewound.id)
    assert messages[3]["tag"] == "DL-01.rectifier.output"
    assert {message["id"] for message in messages[:3]}.isdisjoint({messages[3]["id"]})
    with pytest.raises(PlayerError, match="run_retired"):
        asyncio.run(player.command(store.tx, original_id, "play", PlayerCommand()))


def test_finished_run_can_jump_back_to_a_bookmark() -> None:
    player, store, _, _ = fixture()
    create(player, store)
    execute(player, store, "step")
    execute(player, store, "step")
    finished = execute(player, store, "step")
    assert finished.state == "finished"

    rewound = execute(player, store, "bookmark", {"bookmarkId": "start"})

    assert rewound.id != finished.id
    assert rewound.state == "paused"
    assert rewound.elapsed_seconds == 0
    assert store.tx.resets == 1


def test_reset_reproduces_values_but_retires_message_identities() -> None:
    player, store, transport, _ = fixture()
    create(player, store)
    initial_id = store.tx.snapshot.run.id
    execute(player, store, "bookmark", {"bookmarkId": "failure"})
    first = [json.loads(data) for _, data, _ in transport.messages]
    reset = execute(player, store, "reset")
    assert reset.id != initial_id and reset.state == "ready" and reset.next_event_index == 0
    assert store.tx.resets == 1
    execute(player, store, "bookmark", {"bookmarkId": "failure"})
    second = [json.loads(data) for _, data, _ in transport.messages][3:]
    assert [(s["value"], s["observedAt"]) for s in first] == [
        (s["value"], s["observedAt"]) for s in second
    ]
    assert set(s["id"] for s in first).isdisjoint(s["id"] for s in second)
    assert all(s["simulated"] and s["payload"]["sandbox"] for s in second)
    with pytest.raises(PlayerError, match="run_retired"):
        asyncio.run(player.command(store.tx, initial_id, "play", PlayerCommand()))


def test_hydro_signal_uses_the_demo_b_source_tag_and_payload() -> None:
    player, store, transport, _ = fixture()
    scenario = player.catalog["player-test"]
    rain = next(event for event in scenario.events if event.id == "rain")
    player.catalog[scenario.id] = scenario.model_copy(update={"events": [rain]})
    create(player, store)
    execute(player, store, "step")
    signal = json.loads(transport.messages[0][1])

    assert (signal["source"], signal["tag"], signal["unit"]) == (
        "mock-hydro",
        "rain.rate",
        "mm/h",
    )
    assert signal["classification"] == "CONFIDENTIAL"
    assert 58 <= signal["value"] <= 62
    assert signal["payload"] == {
        "assetCode": "S-R1",
        "zone": "Z3",
        "kind": "rain",
        "target": {"kind": "asset", "id": "S-R1"},
        "label": "SIMULATION",
        "sandbox": True,
    }


def test_pump_signal_uses_the_demo_b_source_tag_and_payload() -> None:
    player, store, transport, _ = fixture()
    scenario = player.catalog["player-test"]
    pump_event = Event.model_validate(
        {
            "id": "pump-loss",
            "atSeconds": 0,
            "source": "mock-pumps",
            "target": {"kind": "asset", "id": "P-3"},
            "tag": "pump.power",
            "value": "lost",
            "unit": "state",
            "payload": {
                "assetCode": "P-3",
                "facilityType": "pump",
                "zone": "Z3",
                "operatingState": "stopped",
            },
        }
    )
    player.catalog[scenario.id] = scenario.model_copy(update={"events": [pump_event]})
    create(player, store)
    execute(player, store, "step")
    signal = json.loads(transport.messages[0][1])

    assert (signal["source"], signal["tag"], signal["value"]) == (
        "mock-pumps",
        "pump.power",
        "lost",
    )
    assert signal["unit"] == "state"
    assert signal["classification"] == "CONFIDENTIAL"
    assert signal["payload"] == {
        "assetCode": "P-3",
        "facilityType": "pump",
        "zone": "Z3",
        "operatingState": "stopped",
        "target": {"kind": "asset", "id": "P-3"},
        "label": "SIMULATION",
        "sandbox": True,
    }


def test_persistent_snapshot_survives_rebuilding_the_player() -> None:
    player, store, _, now = fixture()
    create(player, store)
    execute(player, store, "play")
    store.tx.snapshot = PlayerSnapshot.model_validate_json(
        store.tx.snapshot.model_dump_json(by_alias=True)
    )
    now[0] += timedelta(seconds=80)
    assert asyncio.run(player.read(store.tx)).next_event_index == 3


def test_reset_projection_cannot_be_overwritten_by_an_older_read() -> None:
    player, store, _, _ = fixture()
    historian = SimulatedHistorian(org_id="test-org")
    service = SimulationService(player, lambda: store, historian)
    created = service.execute(
        "/v1/simulation/runs",
        "create-player-test-01",
        RunCreate(scenarioId="player-test", seed=42, speed=1),
    )
    run_id = UUID(str(created["id"]))
    service.execute(
        f"/v1/simulation/runs/{run_id}:step",
        "step-player-test-01",
        PlayerCommand(),
        run_id,
        "step",
    )
    assert historian._overrides

    class ProbeRLock:
        def __init__(self) -> None:
            self.lock = RLock()
            self.guard = Lock()
            self.attempts = 0
            self.second_attempt = ThreadEvent()

        def __enter__(self):
            with self.guard:
                self.attempts += 1
                if self.attempts == 2:
                    self.second_attempt.set()
            self.lock.acquire()
            return self

        def __exit__(self, *_: object) -> None:
            self.lock.release()

    projection_lock = ProbeRLock()
    service._projection_lock = projection_lock  # type: ignore[assignment]
    read_entered = ThreadEvent()
    release_read = ThreadEvent()
    original_reset = historian.reset
    reset_lock = Lock()
    reset_count = 0

    def block_old_read(seed: int | None = None) -> None:
        nonlocal reset_count
        with reset_lock:
            reset_count += 1
            block = reset_count == 1
        if block:
            read_entered.set()
            assert release_read.wait(5)
        original_reset(seed)

    historian.reset = block_old_read
    failures: list[BaseException] = []

    def read_current() -> None:
        try:
            service.current()
        except BaseException as error:
            failures.append(error)

    def reset_run() -> None:
        try:
            service.execute(
                f"/v1/simulation/runs/{run_id}:reset",
                "reset-player-test-01",
                PlayerCommand(),
                run_id,
                "reset",
            )
        except BaseException as error:
            failures.append(error)

    reader = Thread(target=read_current)
    resetter = Thread(target=reset_run)
    reader.start()
    assert read_entered.wait(5), failures
    resetter.start()
    assert projection_lock.second_attempt.wait(5)
    release_read.set()
    reader.join(5)
    resetter.join(5)

    assert not reader.is_alive() and not resetter.is_alive() and not failures
    assert historian._overrides == {}


def test_a_publish_failure_can_be_retried_without_advancing_persistent_state() -> None:
    player, store, transport, _ = fixture()
    create(player, store)

    async def fail(*args):
        raise OSError("publisher unavailable")

    original = transport.publish
    transport.publish = fail
    with pytest.raises(OSError):
        execute(player, store, "step")
    assert store.tx.snapshot.run.next_event_index == 0
    transport.publish = original
    assert execute(player, store, "step").next_event_index == 1


@pytest.mark.parametrize(
    ("cmd", "body"),
    [("play", {"speed": 2}), ("reset", {"bookmarkId": "failure"}), ("speed", {}), ("bookmark", {})],
)
def test_command_bodies_cannot_silently_ignore_fields(cmd: str, body: dict) -> None:
    player, store, _, _ = fixture()
    create(player, store)
    with pytest.raises(PlayerError):
        execute(player, store, cmd, body)
