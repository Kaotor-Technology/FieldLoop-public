"""No-I/O characterization of the production retrieval primitive, not AC4 acceptance."""

import asyncio

import pytest
from fieldloop_assistant.knowledge import BBox, KnowledgeScope, KnowledgeSearch, search_sql

FOLDER = "Company Standards/Procedures"


class ForbiddenDependency:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def __getattr__(self, name: str) -> None:
        self.calls.append(name)
        raise AssertionError(f"Forbidden runtime dependency touched: {name}")


@pytest.mark.parametrize("spatial", [False, True])
def test_sql_filters_both_candidate_branches_before_limits(spatial: bool) -> None:
    sql = " ".join(search_sql(spatial).split())
    semantic, rest = sql.split("), lexical AS MATERIALIZED")
    lexical = rest.split("), scored AS")[0]
    for branch in (semantic, lexical):
        for predicate in (
            "d.status = 'current'", "d.superseded_by IS NULL", "c.org_id = %(org)s",
            "d.folder = ANY(%(folders)s)", "d.classification = ANY(%(classes)s)",
            "c.classification = ANY(%(classes)s)", "c.embedding_model = %(model)s",
            "c.indexed_licence = d.licence",
        ):
            assert predicate in branch
            assert branch.index(predicate) < branch.index("LIMIT 100")
    assert "c.embedding <-> %(vector)s::vector" in sql
    assert "websearch_to_tsquery('simple', %(query)s)" in sql
    assert "60 + row_number() OVER (ORDER BY distance, id)" in sql
    assert "60 + row_number() OVER (ORDER BY rank DESC, id)" in sql
    assert "sum(score) AS score" in sql
    assert "ORDER BY f.score DESC, c.id LIMIT %(limit)s" in sql
    assert ("ST_Intersects" in sql) is spatial


@pytest.mark.parametrize(
    "query,folders,bbox,limit,error",
    [
        ("", [FOLDER], None, 10, ValueError),
        (" " * 3, [FOLDER], None, 10, ValueError),
        ("x" * 1201, [FOLDER], None, 10, ValueError),
        ("survey", [FOLDER], None, 0, ValueError),
        ("survey", [FOLDER], None, 21, ValueError),
        ("survey", [], None, 10, PermissionError),
        ("survey", ["Restricted"], None, 10, PermissionError),
        ("survey", [FOLDER], (180, 0, -180, 1), 10, ValueError),
        ("survey", [FOLDER], (0, 0, float("nan"), 1), 10, ValueError),
        ("survey", [FOLDER], (0, 91, 1, 92), 10, ValueError),
    ],
)
def test_invalid_query_is_rejected_before_dependencies(
    query: str, folders: list[str], bbox: BBox | None, limit: int, error: type[Exception]
) -> None:
    tripwire = ForbiddenDependency()
    search = KnowledgeSearch(
        tripwire, tripwire, KnowledgeScope("contract-test", (FOLDER,), ("PUBLIC",))
    )
    with pytest.raises(error):
        asyncio.run(search.search_knowledge(query, folders, bbox, limit=limit))
    assert tripwire.calls == []


@pytest.mark.parametrize(
    "query", ["cathodic protection survey interval", "การป้องกันการกัดกร่อน protection"]
)
def test_query_reaches_embedding_port_unchanged_and_denial_propagates(query: str) -> None:
    tripwire = ForbiddenDependency()
    requests: list[tuple[list[str], str]] = []
    denied = PermissionError("Local test denial; no embedding execution")

    class EmbeddingGate:
        async def embed(self, texts: list[str], task: str) -> None:
            requests.append((texts, task))
            raise denied

    search = KnowledgeSearch(
        tripwire, EmbeddingGate(), KnowledgeScope("contract-test", (FOLDER,), ("PUBLIC",))
    )
    with pytest.raises(PermissionError) as caught:
        asyncio.run(search.search_knowledge(query, [FOLDER]))
    assert caught.value is denied
    assert requests == [([query], "RETRIEVAL_QUERY")]
    assert tripwire.calls == []
