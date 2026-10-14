"""Session store and step trace (architecture §7.1, §7.6).

`assistant_session` and `agent_step` are application tables written for trace and audit; ADK's
own session storage lives in the `adk` schema and is not touched here.
"""

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol
from uuid import uuid4

from psycopg import AsyncConnection
from psycopg.rows import DictRow
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

RESULT_SUMMARY_LIMIT = 500


def args_hash(args: Mapping[str, Any]) -> str:
    canonical = json.dumps(args, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def summarize(value: Any) -> str:
    """A bounded, non-sensitive summary; the full result is never copied into the trace."""
    text = value if isinstance(value, str) else json.dumps(value, default=str, ensure_ascii=False)
    return text[:RESULT_SUMMARY_LIMIT]


@dataclass(frozen=True)
class SessionRecord:
    id: str
    org_id: str
    agent_id: str
    user_sub: str
    simulated: bool
    classification: str
    status: str


@dataclass
class StepRecord:
    kind: str  # model | tool | handoff | guardrail | answer
    agent_id: str
    tool_name: str | None = None
    args_hash: str | None = None
    result_summary: str | None = None
    guardrail_decision: str | None = None
    model: str | None = None
    tokens_in: int | None = None
    tokens_out: int | None = None
    latency_ms: int | None = None
    action_request_id: str | None = None
    seq: int = 0


class SessionStore(Protocol):
    async def create(
        self, *, org_id: str, agent_id: str, user_sub: str, simulated: bool, classification: str
    ) -> SessionRecord: ...

    async def get(self, session_id: str, org_id: str, user_sub: str) -> SessionRecord | None: ...

    async def set_status(self, session_id: str, org_id: str, status: str, tokens: int) -> None: ...


class TraceSink(Protocol):
    async def record(self, session: SessionRecord, step: StepRecord) -> None: ...


@dataclass
class MemoryStore:
    """In-process store used by tests and local runs without a database."""

    sessions: dict[str, SessionRecord] = field(default_factory=dict)
    steps: list[tuple[str, StepRecord]] = field(default_factory=list)
    tokens: dict[str, int] = field(default_factory=dict)

    async def create(
        self, *, org_id: str, agent_id: str, user_sub: str, simulated: bool, classification: str
    ) -> SessionRecord:
        record = SessionRecord(
            str(uuid4()), org_id, agent_id, user_sub, simulated, classification, "active"
        )
        self.sessions[record.id] = record
        return record

    async def get(self, session_id: str, org_id: str, user_sub: str) -> SessionRecord | None:
        found = self.sessions.get(session_id)
        return found if found and found.org_id == org_id and found.user_sub == user_sub else None

    async def set_status(self, session_id: str, org_id: str, status: str, tokens: int) -> None:
        current = self.sessions[session_id]
        self.sessions[session_id] = SessionRecord(
            current.id, current.org_id, current.agent_id, current.user_sub,
            current.simulated, current.classification, status,
        )
        self.tokens[session_id] = tokens

    async def record(self, session: SessionRecord, step: StepRecord) -> None:
        self.steps.append((session.id, step))


class PostgresStore:
    def __init__(self, pool: AsyncConnectionPool[AsyncConnection[DictRow]]) -> None:
        self._pool = pool

    async def create(
        self, *, org_id: str, agent_id: str, user_sub: str, simulated: bool, classification: str
    ) -> SessionRecord:
        async with self._pool.connection() as connection, connection.transaction():
            cursor = await connection.execute(
                """
                INSERT INTO app.assistant_session
                    (org_id, agent_id, app_user_id, context, status, token_budget_used,
                     simulated, classification, created_by)
                VALUES (%(org)s, %(agent)s,
                        (SELECT id FROM app.app_user
                         WHERE org_id = %(org)s AND keycloak_sub = %(sub)s),
                        %(context)s, 'active', 0, %(simulated)s, %(classification)s, %(sub)s)
                RETURNING id
                """,
                {
                    "org": org_id, "agent": agent_id, "sub": user_sub, "simulated": simulated,
                    "classification": classification, "context": Jsonb({"on_behalf_of": user_sub}),
                },
            )
            row = await cursor.fetchone()
        assert row is not None
        return SessionRecord(
            str(row["id"]), org_id, agent_id, user_sub, simulated, classification, "active"
        )

    async def get(self, session_id: str, org_id: str, user_sub: str) -> SessionRecord | None:
        async with self._pool.connection() as connection:
            cursor = await connection.execute(
                """
                SELECT id, org_id, agent_id, created_by, simulated, classification, status
                FROM app.assistant_session
                WHERE id = %(id)s AND org_id = %(org)s AND created_by = %(sub)s
                """,
                {"id": session_id, "org": org_id, "sub": user_sub},
            )
            row = await cursor.fetchone()
        if row is None:
            return None
        return SessionRecord(
            str(row["id"]), row["org_id"], row["agent_id"], row["created_by"],
            row["simulated"], row["classification"], row["status"],
        )

    async def set_status(self, session_id: str, org_id: str, status: str, tokens: int) -> None:
        async with self._pool.connection() as connection, connection.transaction():
            await connection.execute(
                """
                UPDATE app.assistant_session
                SET status = %(status)s,
                    token_budget_used = COALESCE(token_budget_used, 0) + %(tokens)s
                WHERE id = %(id)s AND org_id = %(org)s
                """,
                {"id": session_id, "org": org_id, "status": status, "tokens": tokens},
            )

    async def record(self, session: SessionRecord, step: StepRecord) -> None:
        async with self._pool.connection() as connection, connection.transaction():
            await connection.execute(
                """
                INSERT INTO app.agent_step
                    (org_id, session_id, seq, agent_id, kind, tool_name, args_hash, result_summary,
                     guardrail_decision, model, tokens_in, tokens_out, latency_ms,
                     action_request_id, simulated, classification, created_by)
                VALUES (%(org)s, %(session)s, %(seq)s, %(agent)s, %(kind)s, %(tool)s, %(args)s,
                        %(summary)s, %(decision)s, %(model)s, %(tin)s, %(tout)s, %(latency)s,
                        %(ar)s, %(simulated)s, %(classification)s, %(sub)s)
                """,
                {
                    "org": session.org_id, "session": session.id, "seq": step.seq,
                    "agent": step.agent_id, "kind": step.kind, "tool": step.tool_name,
                    "args": step.args_hash, "summary": step.result_summary,
                    "decision": step.guardrail_decision, "model": step.model, "tin": step.tokens_in,
                    "tout": step.tokens_out, "latency": step.latency_ms,
                    "ar": step.action_request_id,
                    "simulated": session.simulated, "classification": session.classification,
                    "sub": session.user_sub,
                },
            )


class PostgresDraftStore:
    """Drafts are platform records that wait for a person; status never leaves `needs_approval`."""

    def __init__(
        self, pool: AsyncConnectionPool[AsyncConnection[DictRow]], org_id: str,
        simulated: bool, classification: str,
    ) -> None:
        self._pool = pool
        self._org_id = org_id
        self._simulated = simulated
        self._classification = classification

    async def create(
        self, *, session_id: str, agent_id: str, user_sub: str, kind: str, content: str,
        citations: list[str],
    ) -> str:
        async with self._pool.connection() as connection, connection.transaction():
            cursor = await connection.execute(
                """
                INSERT INTO app.draft
                    (org_id, assistant_session_id, kind, content, citations, status, simulated,
                     classification, created_by)
                VALUES (%(org)s, %(session)s, %(kind)s, %(content)s, %(citations)s,
                        'needs_approval', %(simulated)s, %(classification)s, %(by)s)
                RETURNING id
                """,
                {
                    "org": self._org_id, "session": session_id, "kind": kind, "content": content,
                    "citations": Jsonb(citations), "simulated": self._simulated,
                    "classification": self._classification,
                    "by": f"agent:{agent_id} on_behalf_of:{user_sub}",
                },
            )
            row = await cursor.fetchone()
        assert row is not None
        return str(row["id"])
