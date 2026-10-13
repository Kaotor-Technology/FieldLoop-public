-- migrate:up
SET search_path = app, public;
-- Bind full-text chunks to the licence checked against the verified corpus.
-- Existing chunks intentionally remain unbound until the operator reindexes them.
ALTER TABLE document_chunk ADD COLUMN indexed_licence text
    CHECK (indexed_licence IS NULL OR btrim(indexed_licence) <> '');

-- migrate:down
SET search_path = app, public;
ALTER TABLE document_chunk DROP COLUMN indexed_licence;
