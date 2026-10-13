import asyncio
import json
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fieldloop_common.generated_simulation import PlayerCommand, RunCreate
from fieldloop_common.memory_transport import InMemoryTransport
from fieldloop_common.signal_publisher import SignalPublisher
from fieldloop_simulator.mock_signals import SimulatedSignalEmitter
from fieldloop_simulator.player import PlayerError, PlayerSnapshot, ScenarioPlayer
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

    @contextmanager
    def transaction(self) -> Iterator[MemoryTransaction]:
        import copy

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


def test_bookmarks_replay_intervening_events_and_reject_backwards_jumps() -> None:
    player, store, transport, _ = fixture()
    create(player, store)
    assert execute(player, store, "bookmark", {"bookmarkId": "failure"}).elapsed_seconds == 60
    assert len(transport.messages) == 3
    execute(player, store, "step")
    with pytest.raises(PlayerError):
        execute(player, store, "bookmark", {"bookmarkId": "failure"})


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


def test_persistent_snapshot_survives_rebuilding_the_player() -> None:
    player, store, _, now = fixture()
    create(player, store)
    execute(player, store, "play")
    store.tx.snapshot = PlayerSnapshot.model_validate_json(
        store.tx.snapshot.model_dump_json(by_alias=True)
    )
    now[0] += timedelta(seconds=80)
    assert asyncio.run(player.read(store.tx)).next_event_index == 3


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
