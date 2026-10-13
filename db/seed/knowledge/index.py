"""Operator-run FL-70 seed job; never runs during application startup."""

import argparse
import asyncio
import os
from pathlib import Path

from fieldloop_adapters.embeddings import vertex_embeddings
from fieldloop_assistant.corpus import load_corpus
from fieldloop_assistant.indexing import index_document
from psycopg import AsyncConnection
from psycopg.rows import dict_row


async def run() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--org-id", default=os.environ.get("FIELDLOOP_ORG_ID"))
    parser.add_argument("--storage-manifest", type=Path, required=True)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[3])
    options = parser.parse_args()
    if not options.org_id:
        parser.error("Set FIELDLOOP_ORG_ID or pass --org-id")
    database_url = os.environ.get("FIELDLOOP_DATABASE_URL")
    project = os.environ.get("GOOGLE_CLOUD_PROJECT")
    if not database_url or not project:
        parser.error("Set FIELDLOOP_DATABASE_URL and GOOGLE_CLOUD_PROJECT")
    sources = load_corpus(options.repo_root, options.org_id, options.storage_manifest)
    # Validation finishes before creating a Vertex client or touching the database.
    embeddings = vertex_embeddings(
        project, os.environ.get("GOOGLE_CLOUD_LOCATION", "asia-southeast1")
    )
    async with await AsyncConnection.connect(
        database_url, row_factory=dict_row, autocommit=True
    ) as connection:
        count = 0
        for source in sources:
            count += await index_document(connection, options.org_id, source, embeddings)
    print(f"Indexed {count} new chunks from {len(sources)} eligible current documents")


if __name__ == "__main__":
    asyncio.run(run())
