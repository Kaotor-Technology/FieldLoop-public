"""Internal retrieval primitive; agent registration/Guardrail execution belongs to FL-88."""

import asyncio
import json
import math
from dataclasses import dataclass
from typing import Any

from fieldloop_adapters.embeddings import Embeddings, validate_embedding
from psycopg import AsyncConnection
from psycopg.rows import DictRow
from psycopg_pool import AsyncConnectionPool

BBox = tuple[float, float, float, float]
CLASSES = frozenset({"PUBLIC", "INTERNAL", "CONFIDENTIAL", "HIGHLY_RESTRICTED"})


@dataclass(frozen=True)
class KnowledgeScope:
    """Construct from verified user access, never from agent-supplied arguments."""

    org_id: str
    folders: tuple[str, ...]
    classifications: tuple[str, ...]

    def __post_init__(self) -> None:
        if not self.org_id.strip() or not self.folders or not self.classifications:
            raise ValueError("Knowledge access must be explicitly scoped")
        if any(not folder.strip() for folder in self.folders):
            raise ValueError("Invalid permitted folders")
        if not set(self.classifications) <= CLASSES:
            raise ValueError("Unknown classification")


# Filter in both candidate branches, before LIMIT: other tenants cannot exhaust candidates.
FILTER = """
    JOIN app.controlled_document d ON d.id = c.document_id AND d.org_id = c.org_id
    WHERE c.org_id = %(org)s AND d.status = 'current' AND d.superseded_by IS NULL
      AND d.folder = ANY(%(folders)s) AND d.classification = ANY(%(classes)s)
      AND c.classification = ANY(%(classes)s) AND c.embedding IS NOT NULL
      AND c.embedding_model = %(model)s
"""
SPATIAL = """
      AND c.geom_classification = ANY(%(classes)s)
      AND c.geom && ST_MakeEnvelope(%(west)s, %(south)s, %(east)s, %(north)s, 4326)
      AND ST_Intersects(c.geom, ST_MakeEnvelope(%(west)s, %(south)s, %(east)s, %(north)s, 4326))
"""


def search_sql(spatial: bool) -> str:
    filters = FILTER + (SPATIAL if spatial else "")
    # Only static SQL fragments are composed. All user values use bound parameters.
    return f"""
        WITH semantic AS MATERIALIZED (
            SELECT c.id, c.embedding <-> %(vector)s::vector AS distance
            FROM app.document_chunk c {filters}
            ORDER BY c.embedding <-> %(vector)s::vector LIMIT 100
        ), lexical AS MATERIALIZED (
            SELECT c.id,
                   ts_rank_cd(c.search_vector, websearch_to_tsquery('simple', %(query)s)) AS rank
            FROM app.document_chunk c {filters}
              AND c.search_vector @@ websearch_to_tsquery('simple', %(query)s)
            ORDER BY rank DESC, c.id LIMIT 100
        ), scored AS (
            SELECT id, 1.0 / (60 + row_number() OVER (ORDER BY distance, id)) AS score FROM semantic
            UNION ALL
            SELECT id, 1.0 / (60 + row_number() OVER (ORDER BY rank DESC, id)) AS score FROM lexical
        ), fused AS (
            SELECT id, sum(score) AS score FROM scored GROUP BY id
        )
        SELECT c.id AS chunk_id, c.content, c.page, c.clause, c.simulated, c.classification,
               d.id AS document_id, d.title, d.revision, d.folder, d.blob_uri, f.score
        FROM fused f JOIN app.document_chunk c ON c.id = f.id
        JOIN app.controlled_document d ON d.id = c.document_id AND d.org_id = c.org_id
        ORDER BY f.score DESC, c.id LIMIT %(limit)s
    """


class KnowledgeSearch:
    def __init__(
        self,
        pool: AsyncConnectionPool[AsyncConnection[DictRow]],
        embeddings: Embeddings,
        scope: KnowledgeScope,
    ) -> None:
        self._pool = pool
        self._embeddings = embeddings
        self._scope = scope

    async def search_knowledge(
        self, query: str, folders: list[str], bbox: BBox | None = None, *, limit: int = 10
    ) -> list[dict[str, Any]]:
        if not query.strip() or len(query) > 1200 or not 1 <= limit <= 20:
            raise ValueError("Invalid knowledge query or limit")
        if not folders or not set(folders) <= set(self._scope.folders):
            raise PermissionError("Requested folders are outside verified user access")
        if bbox is not None:
            west, south, east, north = bbox
            if (
                not all(math.isfinite(n) for n in bbox)
                or not -180 <= west < east <= 180
                or not -90 <= south < north <= 90
            ):
                raise ValueError("Invalid bbox; split antimeridian queries")
        async with asyncio.timeout(1.9):
            vectors = await self._embeddings.embed([query], "RETRIEVAL_QUERY")
            if len(vectors) != 1:
                raise ValueError("Query embedding count mismatch")
            parameters: dict[str, Any] = {
                "org": self._scope.org_id,
                "folders": folders,
                "classes": list(self._scope.classifications),
                "query": query,
                "vector": json.dumps(validate_embedding(vectors[0])),
                "model": self._embeddings.model,
                "limit": limit,
            }
            if bbox is not None:
                parameters.update(zip(("west", "south", "east", "north"), bbox, strict=True))
            async with self._pool.connection() as connection, connection.transaction():
                await connection.execute("SET LOCAL statement_timeout = '1200ms'")
                cursor = await connection.execute(search_sql(bbox is not None), parameters)
                rows = await cursor.fetchall()
        return [
            {
                "chunk_id": str(row["chunk_id"]),
                "content": row["content"],
                "revision": row["revision"],
                "simulated": row["simulated"],
                "classification": row["classification"],
                "score": float(row["score"]),
                "citation": {
                    "document_id": str(row["document_id"]),
                    "title": row["title"],
                    "revision": row["revision"],
                    "page": row["page"],
                    "clause": row["clause"],
                    "source_uri": row["blob_uri"],
                    "folder": row["folder"],
                },
            }
            for row in rows
        ]
