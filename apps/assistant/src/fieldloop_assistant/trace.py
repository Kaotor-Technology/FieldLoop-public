"""Session store and step trace (architecture §7.1, §7.6).

`assistant_session` and `agent_step` are application tables written for trace and audit; ADK's
own session storage lives in the `adk` schema and is not touched here.
"""

import hashlib
import json
import time
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from typing import Any, Literal, Protocol, cast
from uuid import uuid4

from psycopg import AsyncConnection
from psycopg.rows import DictRow
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

RESULT_SUMMARY_LIMIT = 500
# A turn lasts at most 60 s (architecture §7.5), so a longer `running` mark is a crashed turn.
STALE_TURN_SECONDS = 90
# `cancelling` is written by :cancel so a turn on another instance stops between steps.
SessionStatus = Literal["active", "running", "cancelling", "cancelled", "failed"]


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
    status: SessionStatus


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

    async def set_status(
        self, session: SessionRecord, status: SessionStatus, tokens: int
    ) -> None: ...

    async def claim_turn(self, session: SessionRecord) -> int | None:
        """Atomically marks the session `running`; returns the last trace seq, or None if busy.

        `running` and `cancelling` are both busy: a cancelled turn holds the session until it
        writes its final status.

        A `running` mark older than STALE_TURN_SECONDS is a crashed turn and may be reclaimed.
        """
        ...

    async def request_cancel(self, session: SessionRecord) -> bool:
        """Marks a `running` session `cancelling`; False when no turn is running."""
        ...


class TraceSink(Protocol):
    async def record(self, session: SessionRecord, step: StepRecord) -> None: ...


@dataclass
class MemoryStore:
    """In-process store used by tests and local runs without a database."""

    sessions: dict[str, SessionRecord] = field(default_factory=dict)
    steps: list[tuple[str, StepRecord]] = field(default_factory=list)
    tokens: dict[str, int] = field(default_factory=dict)
    claimed_at: dict[str, float] = field(default_factory=dict)

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

    async def set_status(
        self, session: SessionRecord, status: SessionStatus, tokens: int
    ) -> None:
        self.sessions[session.id] = replace(self.sessions[session.id], status=status)
        self.tokens[session.id] = self.tokens.get(session.id, 0) + tokens

    async def claim_turn(self, session: SessionRecord) -> int | None:
        current = self.sessions[session.id]
        started = self.claimed_at.get(session.id, 0.0)
        held = current.status in ("running", "cancelling")
        if held and time.monotonic() - started < STALE_TURN_SECONDS:
            return None  # a `cancelling` turn is still running until it writes its final status
        self.sessions[session.id] = replace(current, status="running")
        self.claimed_at[session.id] = time.monotonic()
        return max((s.seq for sid, s in self.steps if sid == session.id), default=0)

    async def request_cancel(self, session: SessionRecord) -> bool:
        current = self.sessions[session.id]
        if current.status not in ("running", "cancelling"):
            return False
        self.sessions[session.id] = replace(current, status="cancelling")
        return True

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
            row["simulated"], row["classification"], cast(SessionStatus, row["status"]),
        )

    async def set_status(
        self, session: SessionRecord, status: SessionStatus, tokens: int
    ) -> None:
        async with self._pool.connection() as connection, connection.transaction():
            await connection.execute(
                """
                UPDATE app.assistant_session
                SET status = %(status)s, status_updated_at = now(),
                    token_budget_used = COALESCE(token_budget_used, 0) + %(tokens)s
                WHERE id = %(id)s AND org_id = %(org)s
                """,
                {"id": session.id, "org": session.org_id, "status": status, "tokens": tokens},
            )

    async def claim_turn(self, session: SessionRecord) -> int | None:
        async with self._pool.connection() as connection, connection.transaction():
            cursor = await connection.execute(
                """
                UPDATE app.assistant_session
                SET status = 'running', status_updated_at = now()
                WHERE id = %(id)s AND org_id = %(org)s
                  AND (status NOT IN ('running', 'cancelling')
                       OR status_updated_at < now() - make_interval(secs => %(stale)s))
                RETURNING id
                """,
                {"id": session.id, "org": session.org_id, "stale": STALE_TURN_SECONDS},
            )
            if await cursor.fetchone() is None:
                return None
            cursor = await connection.execute(
                "SELECT COALESCE(max(seq), 0) AS last FROM app.agent_step WHERE session_id = %s",
                (session.id,),
            )
            row = await cursor.fetchone()
        return int(row["last"]) if row else 0

    async def request_cancel(self, session: SessionRecord) -> bool:
        async with self._pool.connection() as connection, connection.transaction():
            cursor = await connection.execute(
                """
                UPDATE app.assistant_session SET status = 'cancelling', status_updated_at = now()
                WHERE id = %(id)s AND org_id = %(org)s
                  AND status IN ('running', 'cancelling') RETURNING id
                """,
                {"id": session.id, "org": session.org_id},
            )
            return await cursor.fetchone() is not None

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
