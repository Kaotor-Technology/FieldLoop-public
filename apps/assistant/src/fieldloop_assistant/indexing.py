"""One-time document indexing. A rerun reuses complete, unchanged embeddings."""

import hashlib
import json
from uuid import NAMESPACE_URL, uuid5

from fieldloop_adapters.embeddings import Embeddings, validate_embedding
from psycopg import AsyncConnection
from psycopg.rows import DictRow, dict_row

from fieldloop_assistant.chunking import CHUNKER_VERSION, chunk_text
from fieldloop_assistant.corpus import DocumentSource

CREATED_BY = "seed:fl-70-knowledge"


async def index_document(
    connection: AsyncConnection[DictRow],
    org_id: str,
    source: DocumentSource,
    embeddings: Embeddings,
) -> int:
    """Return newly embedded chunk count. No legal lifecycle promotion is permitted."""
    if not org_id.strip() or source.status != "current":
        raise ValueError("Only current documents in an explicit Organisation may be indexed")
    chunks = chunk_text(source.text, format=source.format)
    async with connection.transaction():
        await connection.execute("SET LOCAL lock_timeout = '5s'")
        # Concurrent job retries serialize before any paid embedding calls.
        await connection.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (f"{org_id}:{source.id}",)
        )
        if source.simulated:
            await connection.execute(
                """
                INSERT INTO app.controlled_document
                    (id, org_id, title, revision, folder, status, classification,
                     simulated, licence, blob_uri, created_by)
                VALUES (%s, %s, %s, %s, %s, 'current', %s, true, 'synthetic', %s, %s)
                ON CONFLICT (id) DO NOTHING
            """,
                (
                    source.id,
                    org_id,
                    source.title,
                    source.revision,
                    source.folder,
                    source.classification,
                    source.blob_uri,
                    CREATED_BY,
                ),
            )
        cursor = await connection.execute(
            """
            SELECT * FROM app.controlled_document WHERE id = %s AND org_id = %s FOR UPDATE
        """,
            (source.id, org_id),
        )
        document = await cursor.fetchone()
        if document is None:
            raise ValueError("Load the FL-65 legal seed before indexing its documents")
        expected = {
            "title": source.title,
            "revision": source.revision,
            "folder": source.folder,
            "classification": source.classification,
            "simulated": source.simulated,
            "blob_uri": source.blob_uri,
            "licence": source.licence,
        }
        if any(document[k] != v for k, v in expected.items()):
            raise ValueError("Controlled Document metadata differs from the verified corpus")
        if document["status"] != "current" or document["superseded_by"] is not None:
            return 0
        geom: str | None = None
        geom_classification: str | None = None
        if source.asset_code:
            # Source geometry retains its access class, including for bbox queries.
            cursor = await connection.execute(
                """
                SELECT ST_AsText(ST_Collect(ST_LineSubstring(s.geom,
                    greatest(0, (%s - s.chainage_from) / (s.chainage_to - s.chainage_from))::float8,
                    least(1, (%s - s.chainage_from) / (s.chainage_to - s.chainage_from))::float8
                ) ORDER BY s.chainage_from, s.id)) AS geom
                FROM app.segment s JOIN app.asset a ON a.id = s.asset_id AND a.org_id = s.org_id
                WHERE s.org_id = %s AND a.attributes->>'asset_code' = %s
                    AND s.chainage_from < %s AND s.chainage_to > %s
            """,
                (
                    source.chainage_from,
                    source.chainage_to,
                    org_id,
                    source.asset_code,
                    source.chainage_to,
                    source.chainage_from,
                ),
            )
            geometry = await cursor.fetchone()
            geom = geometry["geom"] if geometry else None
            if geom is None:
                raise ValueError("Load the synthetic DL-01 segments before spatial indexing")
            geom_classification = "HIGHLY_RESTRICTED"
        digest = hashlib.sha256(
            json.dumps(
                {
                    "text": source.text,
                    "revision": source.revision,
                    "format": source.format,
                    "chunker": CHUNKER_VERSION,
                    "model": embeddings.model,
                    "geom": geom,
                },
                sort_keys=True,
                ensure_ascii=False,
            ).encode()
        ).hexdigest()
        cursor = await connection.execute(
            """
            SELECT chunk_index, source_hash, embedding_model, content, page, clause,
                   indexed_licence, embedding IS NOT NULL AS embedded
            FROM app.document_chunk WHERE org_id = %s AND document_id = %s ORDER BY chunk_index
        """,
            (org_id, source.id),
        )
        existing = await cursor.fetchall()
        if len(existing) == len(chunks) and all(
            row["chunk_index"] == i
            and row["source_hash"] == digest
            and row["indexed_licence"] == source.licence
            and row["embedding_model"] == embeddings.model
            and row["embedded"]
            and row["content"] == chunk.content
            and row["page"] == chunk.page
            and row["clause"] == chunk.clause
            for i, (row, chunk) in enumerate(zip(existing, chunks, strict=True))
        ):
            return 0
        vectors = await embeddings.embed([chunk.content for chunk in chunks], "RETRIEVAL_DOCUMENT")
        if len(vectors) != len(chunks):
            raise ValueError("Embedding response count mismatch")
        vectors = [validate_embedding(v) for v in vectors]
        await connection.execute(
            "DELETE FROM app.document_chunk WHERE org_id = %s AND document_id = %s",
            (org_id, source.id),
        )
        async with connection.cursor(row_factory=dict_row) as cursor:
            await cursor.executemany(
                """
                INSERT INTO app.document_chunk
                    (id, org_id, document_id, content, embedding, page, clause, simulated,
                     classification, created_by, chunk_index, source_hash, embedding_model,
                     geom, geom_classification, indexed_licence)
                VALUES (%s, %s, %s, %s, %s::vector, %s, %s, %s, %s, %s, %s, %s, %s,
                        ST_GeomFromText(%s, 4326), %s, %s)
            """,
                [
                    (
                        uuid5(NAMESPACE_URL, f"{source.id}:{digest}:{i}"),
                        org_id,
                        source.id,
                        chunk.content,
                        json.dumps(vector),
                        chunk.page,
                        chunk.clause,
                        source.simulated,
                        source.classification,
                        CREATED_BY,
                        i,
                        digest,
                        embeddings.model,
                        geom,
                        geom_classification,
                        source.licence,
                    )
                    for i, (chunk, vector) in enumerate(zip(chunks, vectors, strict=True))
                ],
            )
    return len(chunks)
