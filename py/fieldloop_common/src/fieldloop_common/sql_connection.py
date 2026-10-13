"""SQL connection adapter: local PostgreSQL or private Cloud SQL with IAM authentication."""

import ssl
from collections.abc import Callable, Mapping
from typing import Any, Protocol, cast
from urllib.parse import parse_qs, unquote, urlparse


class SqlCursor(Protocol):
    def execute(self, query: str, args: tuple[object, ...] = ()) -> None: ...
    def fetchone(self) -> tuple[Any, ...] | None: ...
    def close(self) -> None: ...


class SqlConnection(Protocol):
    def cursor(self) -> SqlCursor: ...
    def commit(self) -> None: ...
    def rollback(self) -> None: ...
    def close(self) -> None: ...


def sql_connection_factory(
    environ: Mapping[str, str],
) -> tuple[Callable[[], SqlConnection], Callable[[], None]]:
    environment = environ.get("FIELDLOOP_ENV", "local")
    if environment not in ("local", "dev", "demo"):
        raise ValueError("Unsupported simulation environment")
    local_url = environ.get("FIELDLOOP_DATABASE_URL")
    if local_url:
        if environment != "local":
            raise ValueError("Cloud runtimes require IAM database authentication")
        url = urlparse(local_url)
        if url.scheme not in ("postgres", "postgresql") or not url.hostname or not url.username:
            raise ValueError("Invalid local database configuration")

        def local_connect() -> SqlConnection:
            from pg8000.dbapi import connect  # type: ignore[import-untyped]

            require_tls = parse_qs(url.query).get("sslmode", ["disable"])[0] != "disable"
            return cast(
                SqlConnection,
                connect(
                    user=unquote(url.username or ""),
                    password=unquote(url.password or ""),
                    host=url.hostname,
                    port=url.port or 5432,
                    database=url.path.lstrip("/"),
                    ssl_context=ssl.create_default_context() if require_tls else False,
                    timeout=10,
                ),
            )

        return local_connect, lambda: None
    instance = environ.get("FIELDLOOP_DB_CONNECTION_NAME")
    database = environ.get("FIELDLOOP_DB_NAME")
    user = environ.get("FIELDLOOP_DB_USER")
    if not instance or not database or not user or environment == "local":
        raise ValueError("Simulation database is not configured")
    # Imports and credential discovery stay lazy: health checks require no cloud access.
    from google.cloud.sql.connector import Connector, IPTypes

    connector = Connector(ip_type=IPTypes.PRIVATE, refresh_strategy="lazy")

    def cloud_connect() -> SqlConnection:
        return cast(
            SqlConnection,
            connector.connect(
                instance,
                "pg8000",
                user=user,
                db=database,
                enable_iam_auth=True,
                timeout=10,
            ),
        )

    return cloud_connect, connector.close
