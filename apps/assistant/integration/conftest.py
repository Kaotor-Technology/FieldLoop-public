"""One idempotent migration of the disposable database for every integration module."""

import os
from pathlib import Path

import pytest
from psycopg import Connection

REPO = Path(__file__).resolve().parents[3]


@pytest.fixture(scope="session", autouse=True)
def migrated_database() -> None:
    dsn = os.environ["FIELDLOOP_KNOWLEDGE_TEST_DSN"]
    with Connection.connect(dsn, autocommit=True) as connection:
        present = connection.execute("SELECT to_regclass('app.assistant_session')").fetchone()
        if present and present[0] is None:
            for migration in sorted((REPO / "db/migrations").glob("*.sql")):
                connection.execute(migration.read_text().split("-- migrate:down")[0])
