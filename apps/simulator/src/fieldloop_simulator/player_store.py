"""One durable workspace per Organisation, serialised commands and atomic baseline reset."""

from __future__ import annotations

import hashlib
import json
import threading
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager

from fieldloop_common.sql_connection import SqlConnection, SqlCursor

from fieldloop_simulator.player import PlayerError, PlayerSnapshot


class PostgresPlayerStore:
    def __init__(self, connect: Callable[[], SqlConnection], org_id: str) -> None:
        self.connect = connect
        self.org_id = org_id
        self._connection: SqlConnection | None = None
        self._lock = threading.RLock()

    @contextmanager
    def transaction(self) -> Iterator[PostgresPlayerTransaction]:
        with self._lock:
            self._connection = self._connection or self.connect()
            connection = self._connection
            cursor = connection.cursor()
            try:
                cursor.execute("SET LOCAL statement_timeout = '15s'")
                cursor.execute("SET LOCAL lock_timeout = '5s'")
                # Serialises even the first creation, before a workspace row exists.
                cursor.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended(%s, 74))", (self.org_id,)
                )
                tx = PostgresPlayerTransaction(cursor, self.org_id)
                yield tx
                connection.commit()
            except BaseException:
                try:
                    connection.rollback()
                except Exception:
                    connection.close()
                    self._connection = None
                raise
            finally:
                cursor.close()

    def asset_codes(self) -> set[str]:
        """Read Asset codes scoped to this service's Organisation for catalog validation."""
        with self._lock:
            self._connection = self._connection or self.connect()
            connection = self._connection
            cursor = connection.cursor()
            try:
                cursor.execute(
                    "SELECT DISTINCT attributes->>'asset_code' FROM app.asset "
                    "WHERE org_id = %s AND attributes ? 'asset_code' "
                    "AND attributes->>'asset_code' IS NOT NULL ORDER BY 1",
                    (self.org_id,),
                )
                codes: set[str] = set()
                while row := cursor.fetchone():
                    if isinstance(row[0], str):
                        codes.add(row[0])
                connection.commit()
                return codes
            except BaseException:
                try:
                    connection.rollback()
                except Exception:
                    connection.close()
                    self._connection = None
                raise
            finally:
                cursor.close()

    def close(self) -> None:
        with self._lock:
            if self._connection:
                self._connection.close()
                self._connection = None


class PostgresPlayerTransaction:
    def __init__(self, cursor: SqlCursor, org_id: str) -> None:
        self.cursor = cursor
        self.org_id = org_id
        cursor.execute(
            "SELECT active_run_id FROM app.simulation_workspace WHERE org_id = %s FOR UPDATE",
            (org_id,),
        )
        workspace = cursor.fetchone()
        self.snapshot: PlayerSnapshot | None = None
        if workspace and workspace[0]:
            cursor.execute(
                "SELECT player_state FROM app.simulation_run WHERE id = %s AND org_id "
                "= %s FOR UPDATE",
                (str(workspace[0]), org_id),
            )
            row = cursor.fetchone()
            if not row or not row[0]:
                raise RuntimeError("The workspace has no durable player state")
            self.snapshot = PlayerSnapshot.model_validate(row[0])

    def restore_baseline(self) -> None:
        self.cursor.execute("SELECT app.restore_simulation_baseline(%s)", (self.org_id,))

    def save(self, snapshot: PlayerSnapshot) -> None:
        if self.snapshot is None:
            self.cursor.execute("SELECT app.capture_simulation_baseline(%s)", (self.org_id,))
        content_hash = hashlib.sha256(
            snapshot.scenario.model_dump_json(by_alias=True).encode()
        ).hexdigest()
        scenario_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"{self.org_id}:{content_hash}"))
        self.cursor.execute(
            "INSERT INTO app.scenario (id, org_id, file, version, simulated, "
            "classification, created_by) "
            "VALUES (%s, %s, %s, %s, true, %s, 'simulator') ON CONFLICT (id) DO NOTHING",
            (
                scenario_id,
                self.org_id,
                snapshot.scenario.id,
                snapshot.scenario.version,
                snapshot.run.classification,
            ),
        )
        run = snapshot.run
        self.cursor.execute(
            "INSERT INTO app.simulation_run (id, org_id, scenario_id, seed, speed, clock, state, "
            "simulated, classification, created_by, player_state) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, true, %s, 'simulator', %s::jsonb) "
            "ON CONFLICT (id) DO UPDATE SET speed=EXCLUDED.speed, clock=EXCLUDED.clock, "
            "state=EXCLUDED.state, player_state=EXCLUDED.player_state",
            (
                str(run.id),
                self.org_id,
                scenario_id,
                run.seed,
                run.speed,
                run.clock,
                run.state,
                run.classification,
                snapshot.model_dump_json(by_alias=True),
            ),
        )
        self.cursor.execute(
            "UPDATE app.simulation_workspace SET active_run_id = %s WHERE org_id = %s",
            (str(run.id), self.org_id),
        )
        self.snapshot = snapshot

    def lookup(self, key: str, digest: str) -> dict[str, object] | None:
        self.cursor.execute(
            "DELETE FROM app.simulation_command WHERE org_id = %s AND created_at < "
            "now() - interval '1 day'",
            (self.org_id,),
        )
        self.cursor.execute(
            "SELECT body_hash, response FROM app.simulation_command WHERE org_id = "
            "%s AND command_key = %s",
            (self.org_id, key),
        )
        row = self.cursor.fetchone()
        if row is None:
            return None
        if row[0] != digest:
            raise PlayerError(409, "idempotency_key_reused")
        response: dict[str, object] = row[1]
        return response

    def remember(self, key: str, digest: str, response: dict[str, object]) -> None:
        self.cursor.execute(
            "INSERT INTO app.simulation_command (org_id, command_key, body_hash, "
            "response, simulated, classification, created_by) "
            "VALUES (%s, %s, %s, %s::jsonb, true, 'HIGHLY_RESTRICTED', 'simulator')",
            (self.org_id, key, digest, json.dumps(response)),
        )
