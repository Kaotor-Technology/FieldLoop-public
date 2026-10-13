from typing import Any

from fieldloop_simulator.player_store import PostgresPlayerStore


class FakeCursor:
    def __init__(self, rows: list[tuple[object, ...]]) -> None:
        self.rows = iter(rows)
        self.query = ""
        self.args: tuple[object, ...] = ()

    def execute(self, query: str, args: tuple[object, ...] = ()) -> None:
        self.query = query
        self.args = args

    def fetchone(self) -> tuple[Any, ...] | None:
        return next(self.rows, None)

    def close(self) -> None:
        pass


class FakeConnection:
    def __init__(self, cursor: FakeCursor) -> None:
        self.fake_cursor = cursor
        self.commits = 0

    def cursor(self) -> FakeCursor:
        return self.fake_cursor

    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        pass

    def close(self) -> None:
        pass


def test_asset_code_lookup_is_scoped_to_the_service_organisation() -> None:
    cursor = FakeCursor([("DL-01",), ("S-R1",), (None,)])
    connection = FakeConnection(cursor)

    def connect() -> FakeConnection:
        return connection

    store = PostgresPlayerStore(connect, "synthetic-org")

    assert store.asset_codes() == {"DL-01", "S-R1"}
    assert "FROM app.asset" in cursor.query
    assert "WHERE org_id = %s" in cursor.query
    assert cursor.args == ("synthetic-org",)
    assert connection.commits == 1
