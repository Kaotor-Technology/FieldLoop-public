# Knowledge indexing (FL-70)

Run this operator job once after the reviewed corpus, legal seed and DL-01
segments are loaded in the target Organisation. It does not run on service
startup or deployment. Apply the repository migrations first.
Use Node from `.nvmrc` and pnpm from the root `packageManager`; the existing
FL-65 corpus gate and legal handoff require their locked Node dependencies.

```bash
pnpm install --frozen-lockfile
uv sync --locked --all-packages
# Use the approved private database connection and an authorised Vertex identity.
# Provide FIELDLOOP_DATABASE_URL through the existing secret workflow, never as a CLI argument.
export FIELDLOOP_ORG_ID=fieldloop-demo
export GOOGLE_CLOUD_PROJECT=example-project
export GOOGLE_CLOUD_LOCATION=asia-southeast1
uv run --locked --all-packages python db/seed/knowledge/index.py \
  --storage-manifest data/corpus/legal/storage/dev.json
```

Select the storage report matching the target environment (`dev.json` or
`demo.json`); the job checks it against the existing database source binding.
Use Application Default Credentials with the approved runtime/seed identity.
Do not copy tokens or service-account keys into the repository.

The job runs the FL-65 content-bound human-review delivery gate and consumes
its eligible legal handoff. It indexes 120 current synthetic revision-B
documents and five current legal snapshots. Superseded revisions, quarantined
text, drafts, unverified legal metadata and unlicensed reference-only standards
are excluded. Original legal PDFs remain the citation source; chunks retain
PDF page numbers or eCFR section IDs. Markdown has a clause heading and no
invented page number.

A document transaction locks its current Controlled Document, checks its
revision/source metadata, embeds through the Python adapter in
`packages/adapters/python`, and replaces its chunks atomically. A complete
unchanged source/model/chunker/geometry is reused without another document
embedding call. A failed run can be resumed: completed documents remain valid;
the failed document retains its prior index. Database lifecycle changes are
never promoted back to current by the job. Synthetic geometry is clipped to
the document's Chainage and has `HIGHLY_RESTRICTED` spatial access.

Each chunk stores `indexed_licence`, the licence bound to its verified full-text
source. Retrieval requires an exact match to the current Controlled Document
licence in both candidate branches. A changed, missing or empty licence therefore
revokes old full-text results immediately, without relying on a reindex attempt.
This is not an allowlist inferred from free-form licence wording: only the existing
reviewed corpus/eligible legal handoff supplies full-text sources to this job.
Migration `20261013000000` leaves existing chunks unbound (not retrievable); rerun
the verified indexing job to rebuild them. The unchanged-index shortcut checks
this binding too. No legal/Document Controller decision is promoted by migration.
Controlled Document title/revision/licence metadata is retained. This full-text
primitive does not return reference-only text; FL-88 must use authorised metadata
for KL-9 reference-only citations and label them "not verified against source text".

## Retrieval handoff to FL-88

`fieldloop_assistant.knowledge.KnowledgeSearch` accepts a reusable async
Postgres pool, an `Embeddings` port and a `KnowledgeScope`. Build the scope from
verified user identity and access, never from model arguments. Requested folders
must be a subset of those permissions. Organisation, folder, classification,
current revision and optional PostGIS bbox filters apply before ranking. Access
must cover both document and chunk classifications; returned `classification`
is the higher current label in PRD §9.1 order (PUBLIC, INTERNAL, CONFIDENTIAL,
HIGHLY_RESTRICTED), including when a document is reclassified after indexing.

Call `await search.search_knowledge(query, folders, bbox=None)` after the agent
runtime's `tool-calls:check`. The primitive is not registered as an agent tool
or exposed over HTTP by FL-70. FL-88 owns registration, verified identity,
retrieved-content scanning and citation rendering. The result contains chunk
content, revision, simulated/classification labels, RRF score and a citation
with document ID, title, revision, page/clause, source URI and folder. Original
source URIs must be resolved through authorised document access, not exposed
as public links. No graph traversal is implemented in the demo slice.

Hybrid ranking fuses HNSW-compatible L2 semantic candidates and PostgreSQL
`simple` full-text candidates using reciprocal rank fusion. The multilingual
adapter uses `RETRIEVAL_DOCUMENT` for the seed and `RETRIEVAL_QUERY` for queries,
768 dimensions, five-input batches and no silent truncation. Only query text
is embedded at request time; corpus embeddings are never recomputed then.
Query embedding plus pool wait and SQL have a 1.9-second overall deadline;
Postgres also has a 1.2-second statement timeout. An error or timeout propagates
instead of producing fabricated results.

Google's [embedding API](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/text-embeddings-api)
and [task types](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/embeddings/task-types)
document the multilingual model, dimensions, batch limit and document/query tasks.

## Validation and limits

```bash
uv run --locked --all-packages pytest
bash scripts/test-knowledge.sh
bash scripts/test-migrations.sh
```

The database integration suite uses a disposable PostgreSQL 16 with PostGIS
and pgvector 0.8.1 and the reviewed corpus, with deterministic fake embeddings
and no GCP calls. It verifies rerun caching, transactional rollback, revision
and tenant isolation, folder/classification permissions, clipped spatial access,
Thai/English queries and citations. It prints measured p50/p95 over 40 calls and
writes `EXPLAIN (ANALYZE, BUFFERS)` to `/tmp/fl70-query-plan.json`.

At this small dataset size the planner may select exact scans rather than
HNSW/GIN/GIST. The indexes exist and the query operators match them; this is
not a large-corpus performance claim. Vertex quality, live embedding latency,
Cloud SQL latency, real dev/demo indexing and monthly billing have not been
measured by the fake-model suite. Verify those with the approved credentials
and environment before declaring the live pre-indexed demo ready.
