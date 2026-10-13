-- migrate:up
SET search_path = app, public;
ALTER TABLE controlled_document ADD CONSTRAINT controlled_document_org_id_id UNIQUE (org_id, id);
ALTER TABLE document_chunk ADD CONSTRAINT document_chunk_org_document_fk
    FOREIGN KEY (org_id, document_id) REFERENCES controlled_document (org_id, id);
ALTER TABLE document_chunk
    ADD COLUMN chunk_index integer CHECK (chunk_index >= 0),
    ADD COLUMN source_hash text,
    ADD COLUMN embedding_model text,
    ADD COLUMN geom geometry(Geometry, 4326),
    ADD COLUMN geom_classification text,
    ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content, ''))) STORED,
    ADD CONSTRAINT document_chunk_geom_classification CHECK (
        (geom IS NULL AND geom_classification IS NULL) OR
        (geom IS NOT NULL AND geom_classification IS NOT NULL AND
         geom_classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'HIGHLY_RESTRICTED'))
    );
CREATE UNIQUE INDEX idx_document_chunk_ordinal ON document_chunk (org_id, document_id, chunk_index);
CREATE INDEX idx_document_chunk_search ON document_chunk USING GIN (search_vector);
CREATE INDEX idx_document_chunk_geom ON document_chunk USING GIST (geom);
CREATE INDEX idx_controlled_document_retrieval ON controlled_document (org_id, folder, status);
-- Existing HNSW vector_l2_ops index is retained: queries order by the matching <-> operator.

-- migrate:down
SET search_path = app, public;
DROP INDEX idx_controlled_document_retrieval;
DROP INDEX idx_document_chunk_geom;
DROP INDEX idx_document_chunk_search;
DROP INDEX idx_document_chunk_ordinal;
ALTER TABLE document_chunk DROP CONSTRAINT document_chunk_org_document_fk;
ALTER TABLE document_chunk DROP CONSTRAINT document_chunk_geom_classification;
ALTER TABLE document_chunk DROP COLUMN chunk_index, DROP COLUMN source_hash,
    DROP COLUMN embedding_model, DROP COLUMN geom, DROP COLUMN geom_classification,
    DROP COLUMN search_vector;
ALTER TABLE controlled_document DROP CONSTRAINT controlled_document_org_id_id;
