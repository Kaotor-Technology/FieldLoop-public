"""Always executed against a disposable, migrated PostGIS + pgvector database."""

import asyncio
import hashlib
import json
import math
import os
import statistics
import subprocess
import time
from collections.abc import Sequence
from dataclasses import replace
from pathlib import Path
from uuid import uuid4

import pytest
from fieldloop_adapters.embeddings import EmbeddingTask
from fieldloop_assistant.corpus import DocumentSource, load_corpus
from fieldloop_assistant.indexing import index_document
from fieldloop_assistant.knowledge import KnowledgeScope, KnowledgeSearch, search_sql
from psycopg import AsyncConnection, Connection
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

REPO = Path(__file__).resolve().parents[3]
DSN = os.environ["FIELDLOOP_KNOWLEDGE_TEST_DSN"]


class FakeEmbeddings:
    """Free, deterministic test vectors; no claim of Vertex retrieval quality."""

    model = "fixture-multilingual-768"

    def __init__(self) -> None:
        self.calls: list[EmbeddingTask] = []
        self.fail = False

    async def embed(self, texts: Sequence[str], task: EmbeddingTask) -> list[list[float]]:
        self.calls.append(task)
        if self.fail:
            raise RuntimeError("fixture embedding outage")
        return [
            [(hashlib.sha256(text.encode()).digest()[i % 32] - 127) / 128 for i in range(768)]
            for text in texts
        ]


@pytest.fixture(scope="session", autouse=True)
def migrated_database() -> None:
    with Connection.connect(DSN, autocommit=True) as connection:
        for migration in sorted((REPO / "db/migrations").glob("*.sql")):
            connection.execute(migration.read_text().split("-- migrate:down")[0])


def source() -> DocumentSource:
    return DocumentSource(
        id=uuid4(),
        title="SYNTHETIC CP procedure",
        revision="B",
        folder="Company Standards/Procedures",
        status="current",
        classification="INTERNAL",
        simulated=True,
        blob_uri="synthetic://fixture/cp-b",
        text="## CP survey\ncathodic protection survey interval\nการป้องกันการกัดกร่อน",
        format="markdown",
    )


def test_index_rerun_rollback_revision_guard_and_org_isolation() -> None:
    async def exercise() -> None:
        embedding = FakeEmbeddings()
        item = source()
        async with await AsyncConnection.connect(
            DSN, row_factory=dict_row, autocommit=True
        ) as connection:
            assert await index_document(connection, "index-fixture", item, embedding) == 1
            assert await index_document(connection, "index-fixture", item, embedding) == 0
            assert embedding.calls == ["RETRIEVAL_DOCUMENT"]
            embedding.fail = True
            with pytest.raises(RuntimeError):
                await index_document(
                    connection,
                    "index-fixture",
                    replace(item, text="## Changed\nchanged input"),
                    embedding,
                )
            row = await (
                await connection.execute(
                    "SELECT content FROM app.document_chunk WHERE document_id = %s", (item.id,)
                )
            ).fetchone()
            assert row and "cathodic protection" in row["content"]
            with pytest.raises(ValueError):
                await index_document(connection, "other-org", item, embedding)
            await connection.execute(
                "UPDATE app.controlled_document SET status='withdrawn' WHERE id=%s", (item.id,)
            )
            assert await index_document(connection, "index-fixture", item, embedding) == 0
            with pytest.raises(ValueError):
                await index_document(
                    connection,
                    "legal-fixture",
                    replace(item, id=uuid4(), simulated=False, classification="PUBLIC"),
                    embedding,
                )

    asyncio.run(exercise())


def test_hybrid_retrieval_access_citations_bbox_and_input_validation() -> None:
    async def exercise() -> None:
        embedding = FakeEmbeddings()
        current = source()
        async with await AsyncConnection.connect(
            DSN, row_factory=dict_row, autocommit=True
        ) as connection:
            for org, item in [
                ("search-fixture", current),
                ("search-fixture", replace(source(), classification="CONFIDENTIAL")),
                ("search-fixture", replace(source(), folder="Restricted")),
                ("other-org", source()),
            ]:
                await index_document(connection, org, item, embedding)
            for status in ["superseded", "withdrawn", "draft", "status unverified"]:
                item = source()
                await index_document(connection, "search-fixture", item, embedding)
                await connection.execute(
                    "UPDATE app.controlled_document SET status=%s WHERE id=%s", (status, item.id)
                )
            await connection.execute(
                """
                UPDATE app.document_chunk SET geom=ST_SetSRID(ST_Point(100.5, 13.7), 4326),
                    geom_classification='HIGHLY_RESTRICTED' WHERE document_id=%s
            """,
                (current.id,),
            )
        async with AsyncConnectionPool(DSN, kwargs={"row_factory": dict_row}) as pool:
            scope = KnowledgeScope("search-fixture", (current.folder,), ("PUBLIC", "INTERNAL"))
            search = KnowledgeSearch(pool, embedding, scope)
            results = await search.search_knowledge("cathodic protection", [current.folder])
            assert len(results) == 1
            citation = results[0]["citation"]
            assert citation["document_id"] == str(current.id)
            assert citation["revision"] == "B" and citation["clause"] == "CP survey"
            assert citation["page"] is None and citation["source_uri"] == current.blob_uri
            assert results[0]["simulated"] is True
            assert await search.search_knowledge("การป้องกันการกัดกร่อน protection", [current.folder])
            assert len(await search.search_knowledge("' OR 1=1 --", [current.folder])) == 1
            assert (
                await search.search_knowledge("protection", [current.folder], (100, 13, 101, 14))
                == []
            )
            geo_search = KnowledgeSearch(
                pool,
                embedding,
                replace(scope, classifications=scope.classifications + ("HIGHLY_RESTRICTED",)),
            )
            assert (
                len(
                    await geo_search.search_knowledge(
                        "protection", [current.folder], (100, 13, 101, 14)
                    )
                )
                == 1
            )
            assert (
                await geo_search.search_knowledge(
                    "protection", [current.folder], (101, 13, 102, 14)
                )
                == []
            )
            calls = len(embedding.calls)
            with pytest.raises(PermissionError):
                await search.search_knowledge("x", ["Restricted"])
            for bbox in [(180, 0, -180, 1), (0, 0, math.nan, 1), (0, 91, 1, 92)]:
                with pytest.raises(ValueError):
                    await search.search_knowledge("x", [current.folder], bbox)
            with pytest.raises(ValueError):
                await search.search_knowledge("", [current.folder])
            assert len(embedding.calls) == calls
            embedding.fail = True
            with pytest.raises(RuntimeError):
                await search.search_knowledge("x", [current.folder])

    asyncio.run(exercise())


def test_verified_corpus_indexing_and_measured_hybrid_latency() -> None:
    async def exercise() -> None:
        org = "corpus-fixture"
        env = {
            **os.environ,
            "FIELDLOOP_ORG_ID": org,
            "FIELDLOOP_DATABASE_URL": DSN,
            "FIELDLOOP_STORAGE_MANIFEST": str(REPO / "data/corpus/legal/storage/dev.json"),
        }
        for loader in ["db/seed/dl-01/seed.mjs", "db/seed/legal-corpus/seed.mjs"]:
            subprocess.run(["node", loader], cwd=REPO, env=env, check=True, capture_output=True)
        sources = load_corpus(REPO, org, REPO / "data/corpus/legal/storage/dev.json")
        assert len(sources) == 125
        assert len([s for s in sources if not s.simulated]) == 5
        assert all("Water Resources" not in s.title for s in sources)
        embedding = FakeEmbeddings()
        async with await AsyncConnection.connect(
            DSN, row_factory=dict_row, autocommit=True
        ) as connection:
            count = 0
            for item in sources:
                count += await index_document(connection, org, item, embedding)
            calls = len(embedding.calls)
            for item in sources:
                assert await index_document(connection, org, item, embedding) == 0
            assert len(embedding.calls) == calls
            await connection.execute("ANALYZE app.document_chunk")
            await connection.execute("ANALYZE app.controlled_document")
        async with AsyncConnectionPool(DSN, kwargs={"row_factory": dict_row}) as pool:
            scope = KnowledgeScope(
                org,
                tuple(sorted({s.folder for s in sources})),
                ("PUBLIC", "INTERNAL", "HIGHLY_RESTRICTED"),
            )
            search = KnowledgeSearch(pool, embedding, scope)
            timings = []
            for query in ["cathodic protection survey interval", "การป้องกันการกัดกร่อน protection"]:
                for _ in range(20):
                    start = time.perf_counter()
                    results = await search.search_knowledge(query, list(scope.folders))
                    timings.append((time.perf_counter() - start) * 1000)
                    assert results and all(r["revision"] for r in results)
            p50 = statistics.median(timings)
            p95 = sorted(timings)[math.ceil(len(timings) * 0.95) - 1]
            assert p95 < 2000
            async with pool.connection() as connection:
                # Record the real planner; inspect index capability separately on a small seed.
                params = {
                    "org": org,
                    "folders": list(scope.folders),
                    "classes": list(scope.classifications),
                    "query": "cathodic protection",
                    "vector": json.dumps([0.1] * 768),
                    "model": embedding.model,
                    "limit": 10,
                }
                rows = await (
                    await connection.execute(
                        "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + search_sql(False), params
                    )
                ).fetchone()
                assert rows
                plan = rows["QUERY PLAN"][0]
                print(
                    json.dumps(
                        {
                            "documents": len(sources),
                            "chunks": count,
                            "samples": len(timings),
                            "p50_ms": round(p50, 2),
                            "p95_ms": round(p95, 2),
                            "sql_execution_ms": plan["Execution Time"],
                            "embedding": "deterministic fake; no live Vertex measurement",
                        }
                    )
                )
                Path("/tmp/fl70-query-plan.json").write_text(json.dumps(plan, indent=2))

    asyncio.run(exercise())


def test_lexical_rank_improves_a_semantic_distractor() -> None:
    async def exercise() -> None:
        relevant = replace(source(), text="cathodic protection survey interval")
        distractor = replace(source(), text="unrelated synthetic pump inspection")

        class DistractorEmbeddings(FakeEmbeddings):
            async def embed(self, texts: Sequence[str], task: EmbeddingTask) -> list[list[float]]:
                # The query's nearest vector is deliberately wrong; lexical fusion must recover.
                return await super().embed(
                    [distractor.text] if task == "RETRIEVAL_QUERY" else texts, task
                )

        embeddings = DistractorEmbeddings()
        async with await AsyncConnection.connect(
            DSN, row_factory=dict_row, autocommit=True
        ) as connection:
            for item in [relevant, distractor]:
                await index_document(connection, "fusion-fixture", item, embeddings)
        async with AsyncConnectionPool(DSN, kwargs={"row_factory": dict_row}) as pool:
            search = KnowledgeSearch(
                pool,
                embeddings,
                KnowledgeScope("fusion-fixture", (relevant.folder,), ("INTERNAL",)),
            )
            results = await search.search_knowledge(
                "cathodic protection survey interval", [relevant.folder]
            )
            assert results[0]["citation"]["document_id"] == str(relevant.id)
            assert results[0]["score"] > results[1]["score"]

    asyncio.run(exercise())


def test_database_and_embedding_deadlines_fail_closed() -> None:
    async def exercise() -> None:
        item = source()
        scope = KnowledgeScope("deadline-fixture", (item.folder,), ("INTERNAL",))
        embeddings = FakeEmbeddings()
        async with await AsyncConnection.connect(
            DSN, row_factory=dict_row, autocommit=True
        ) as connection:
            await index_document(connection, scope.org_id, item, embeddings)
            async with AsyncConnectionPool(DSN, kwargs={"row_factory": dict_row}) as pool:
                search = KnowledgeSearch(pool, embeddings, scope)
                async with connection.transaction():
                    await connection.execute(
                        "LOCK TABLE app.document_chunk IN ACCESS EXCLUSIVE MODE"
                    )
                    from psycopg.errors import QueryCanceled

                    with pytest.raises(QueryCanceled):
                        await search.search_knowledge("survey", [item.folder])

                class SlowEmbeddings(FakeEmbeddings):
                    async def embed(
                        self, texts: Sequence[str], task: EmbeddingTask
                    ) -> list[list[float]]:
                        await asyncio.sleep(3)
                        return await super().embed(texts, task)

                slow = KnowledgeSearch(pool, SlowEmbeddings(), scope)
                start = time.perf_counter()
                with pytest.raises(TimeoutError):
                    await slow.search_knowledge("survey", [item.folder])
                assert time.perf_counter() - start < 2.5

    asyncio.run(exercise())


@pytest.mark.parametrize("licence", ["reference-only", "unreviewed terms", "", None])
def test_a_human_licence_change_revokes_retrieval_and_prevents_reindexing(
    licence: str | None,
) -> None:
    async def exercise() -> None:
        item = source()
        org = f"licence-{item.id}"
        embeddings = FakeEmbeddings()
        async with await AsyncConnection.connect(
            DSN, row_factory=dict_row, autocommit=True
        ) as connection, AsyncConnectionPool(DSN, kwargs={"row_factory": dict_row}) as pool:
            await index_document(connection, org, item, embeddings)
            search = KnowledgeSearch(
                pool, embeddings, KnowledgeScope(org, (item.folder,), ("INTERNAL",))
            )
            # Matching text exercises the union; a non-match exercises semantic-only retrieval.
            for query in ("cathodic protection", "no-lexical-match"):
                assert len(await search.search_knowledge(query, [item.folder])) == 1
            await connection.execute(
                "UPDATE app.controlled_document SET licence=%s WHERE id=%s",
                (licence, item.id),
            )
            # Revocation takes effect without a reindex or destructive deletion of metadata.
            for query in ("cathodic protection", "no-lexical-match"):
                assert await search.search_knowledge(query, [item.folder]) == []
            with pytest.raises(ValueError, match="metadata differs"):
                await index_document(connection, org, item, embeddings)
            assert embeddings.calls.count("RETRIEVAL_DOCUMENT") == 1
            row = await (
                await connection.execute(
                    "SELECT title, revision, licence FROM app.controlled_document WHERE id=%s",
                    (item.id,),
                )
            ).fetchone()
            assert row == {"title": item.title, "revision": item.revision, "licence": licence}

    asyncio.run(exercise())


@pytest.mark.parametrize(
    ("document_class", "chunk_class", "effective_class"),
    [
        ("PUBLIC", "PUBLIC", "PUBLIC"),
        ("INTERNAL", "PUBLIC", "INTERNAL"),
        ("PUBLIC", "INTERNAL", "INTERNAL"),
        ("CONFIDENTIAL", "INTERNAL", "CONFIDENTIAL"),
        ("INTERNAL", "CONFIDENTIAL", "CONFIDENTIAL"),
        ("HIGHLY_RESTRICTED", "CONFIDENTIAL", "HIGHLY_RESTRICTED"),
        ("CONFIDENTIAL", "HIGHLY_RESTRICTED", "HIGHLY_RESTRICTED"),
        ("HIGHLY_RESTRICTED", "HIGHLY_RESTRICTED", "HIGHLY_RESTRICTED"),
    ],
)
def test_reclassification_returns_highest_current_class_and_enforces_both_scopes(
    document_class: str, chunk_class: str, effective_class: str,
) -> None:
    async def exercise() -> None:
        item = replace(source(), classification=chunk_class)
        org = f"class-{item.id}"
        embeddings = FakeEmbeddings()
        async with await AsyncConnection.connect(
            DSN, row_factory=dict_row, autocommit=True
        ) as connection, AsyncConnectionPool(DSN, kwargs={"row_factory": dict_row}) as pool:
            await index_document(connection, org, item, embeddings)
            await connection.execute(
                "UPDATE app.controlled_document SET classification=%s WHERE id=%s",
                (document_class, item.id),
            )
            scope = KnowledgeScope(
                org, (item.folder,), ("PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED")
            )
            search = KnowledgeSearch(pool, embeddings, scope)
            for query in ("cathodic protection", "no-lexical-match"):
                results = await search.search_knowledge(query, [item.folder])
                assert len(results) == 1
                assert results[0]["classification"] == effective_class
                assert results[0]["citation"]["document_id"] == str(item.id)
                # Missing either current label must still deny access before ranking.
                for denied_class in {document_class, chunk_class}:
                    restricted = KnowledgeSearch(
                        pool, embeddings,
                        replace(scope, classifications=tuple(
                            c for c in scope.classifications if c != denied_class
                        )),
                    )
                    assert await restricted.search_knowledge(query, [item.folder]) == []

    asyncio.run(exercise())


def test_unbound_chunks_fail_closed_until_verified_reindex() -> None:
    async def exercise() -> None:
        item = source()
        org = f"legacy-{item.id}"
        embeddings = FakeEmbeddings()
        async with await AsyncConnection.connect(
            DSN, row_factory=dict_row, autocommit=True
        ) as connection, AsyncConnectionPool(DSN, kwargs={"row_factory": dict_row}) as pool:
            assert await index_document(connection, org, item, embeddings) == 1
            # The additive migration does not backfill unverified permissions on old chunks.
            await connection.execute(
                "UPDATE app.document_chunk SET indexed_licence=NULL WHERE document_id=%s",
                (item.id,),
            )
            search = KnowledgeSearch(
                pool, embeddings, KnowledgeScope(org, (item.folder,), ("INTERNAL",))
            )
            assert await search.search_knowledge("cathodic protection", [item.folder]) == []
            assert await index_document(connection, org, item, embeddings) == 1
            assert len(await search.search_knowledge("cathodic protection", [item.folder])) == 1
            assert await index_document(connection, org, item, embeddings) == 0
            assert embeddings.calls.count("RETRIEVAL_DOCUMENT") == 2

    asyncio.run(exercise())


def test_spatial_index_clips_a_document_to_its_chainage() -> None:
    async def exercise() -> None:
        item = replace(source(), asset_code="DL-01", chainage_from=250, chainage_to=750)
        asset_id = uuid4()
        embeddings = FakeEmbeddings()
        async with await AsyncConnection.connect(
            DSN, row_factory=dict_row, autocommit=True
        ) as connection:
            await connection.execute(
                """
                INSERT INTO app.asset (id,org_id,type,attributes,simulated,classification)
                VALUES (%s, 'clip-fixture', 'linear', '{"asset_code":"DL-01"}', true,
                        'HIGHLY_RESTRICTED')
            """,
                (asset_id,),
            )
            await connection.execute(
                """
                INSERT INTO app.segment
                    (org_id,asset_id,chainage_from,chainage_to,geom,simulated,classification)
                VALUES ('clip-fixture', %s, 0, 1000,
                        ST_GeomFromText('LINESTRING(100 13,101 13)',4326), true,'HIGHLY_RESTRICTED')
            """,
                (asset_id,),
            )
            assert await index_document(connection, "clip-fixture", item, embeddings) == 1
            assert await index_document(connection, "clip-fixture", item, embeddings) == 0
            row = await (
                await connection.execute(
                    """
                SELECT ST_XMin(geom) AS west, ST_XMax(geom) AS east, geom_classification
                FROM app.document_chunk WHERE document_id=%s
            """,
                    (item.id,),
                )
            ).fetchone()
            assert row and row["west"] == 100.25 and row["east"] == 100.75
            assert row["geom_classification"] == "HIGHLY_RESTRICTED"

    asyncio.run(exercise())
