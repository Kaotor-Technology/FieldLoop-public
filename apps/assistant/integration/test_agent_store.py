"""Sessions, trace and Drafts on a disposable, migrated PostgreSQL (architecture §7.1, §7.6)."""

import asyncio
import os
from pathlib import Path

import pytest
from fieldloop_assistant.trace import PostgresDraftStore, PostgresStore, StepRecord, args_hash
from psycopg import AsyncConnection, Connection
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

REPO = Path(__file__).resolve().parents[3]
DSN = os.environ["FIELDLOOP_KNOWLEDGE_TEST_DSN"]
ORG = "org-agent-store"


@pytest.fixture(scope="module", autouse=True)
def migrated() -> None:
    with Connection.connect(DSN, autocommit=True) as connection:
        present = connection.execute("SELECT to_regclass('app.assistant_session')").fetchone()
        if present and present[0] is None:
            for migration in sorted((REPO / "db/migrations").glob("*.sql")):
                connection.execute(migration.read_text().split("-- migrate:down")[0])


def run(coro):  # type: ignore[no-untyped-def]
    async def go():  # type: ignore[no-untyped-def]
        async with AsyncConnectionPool[AsyncConnection](
            DSN, open=False, kwargs={"row_factory": dict_row}
        ) as pool:
            return await coro(pool)

    return asyncio.run(go())


def test_session_is_scoped_to_organisation_and_user_and_status_accumulates_tokens() -> None:
    async def scenario(pool):  # type: ignore[no-untyped-def]
        store = PostgresStore(pool)
        record = await store.create(
            org_id=ORG, agent_id="flood-situation", user_sub="user-1", simulated=True,
            classification="INTERNAL",
        )
        assert (await store.get(record.id, ORG, "user-1")) == record
        assert await store.get(record.id, "other-org", "user-1") is None
        assert await store.get(record.id, ORG, "user-2") is None
        await store.set_status(record.id, ORG, "active", 120)
        await store.set_status(record.id, ORG, "cancelled", 30)
        async with pool.connection() as connection:
            row = await (await connection.execute(
                "SELECT status, token_budget_used FROM app.assistant_session WHERE id = %s",
                (record.id,))).fetchone()
        return row

    assert run(scenario) == {"status": "cancelled", "token_budget_used": 150}


def test_steps_and_drafts_are_stored_with_session_identity() -> None:
    async def scenario(pool):  # type: ignore[no-untyped-def]
        store = PostgresStore(pool)
        record = await store.create(
            org_id=ORG, agent_id="integrity-orchestrator", user_sub="user-1", simulated=True,
            classification="INTERNAL",
        )
        await store.record(record, StepRecord(
            kind="guardrail", agent_id="integrity-orchestrator", tool_name="get_barriers",
            args_hash=args_hash({"bowtie_id": "x"}), guardrail_decision="allow", seq=1,
        ))
        draft_id = await PostgresDraftStore(pool, ORG, True, "INTERNAL").create(
            session_id=record.id, agent_id="report-generator", user_sub="user-1",
            kind="management_summary", content="SYNTHETIC summary", citations=["EV-1"],
        )
        async with pool.connection() as connection:
            step = await (await connection.execute(
                "SELECT org_id, tool_name, guardrail_decision, simulated FROM app.agent_step "
                "WHERE session_id = %s", (record.id,))).fetchone()
            draft = await (await connection.execute(
                "SELECT status, created_by, assistant_session_id, citations FROM app.draft "
                "WHERE id = %s", (draft_id,))).fetchone()
        return step, draft, record.id

    step, draft, session_id = run(scenario)
    assert step == {"org_id": ORG, "tool_name": "get_barriers", "guardrail_decision": "allow",
                    "simulated": True}
    assert draft["status"] == "needs_approval"
    assert draft["created_by"] == "agent:report-generator on_behalf_of:user-1"
    assert str(draft["assistant_session_id"]) == session_id
    assert draft["citations"] == ["EV-1"]
