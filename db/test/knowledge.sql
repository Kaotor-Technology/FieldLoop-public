BEGIN;
SET search_path = app, public;
INSERT INTO controlled_document (id, org_id, title, simulated, classification)
VALUES ('70707070-0000-4000-8000-000000000001', 'knowledge-test', 'SYNTHETIC', true, 'INTERNAL');
DO $$
BEGIN
    BEGIN
        INSERT INTO document_chunk (org_id, document_id, simulated, classification)
        VALUES ('other-org', '70707070-0000-4000-8000-000000000001', true, 'INTERNAL');
        RAISE EXCEPTION 'cross-Organisation chunk accepted';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    BEGIN
        INSERT INTO document_chunk (org_id, document_id, simulated, classification, geom)
        VALUES ('knowledge-test', '70707070-0000-4000-8000-000000000001', true, 'INTERNAL',
                ST_SetSRID(ST_Point(100.5, 13.7), 4326));
        RAISE EXCEPTION 'unclassified geometry accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    IF (SELECT count(*) FROM pg_indexes WHERE schemaname = 'app' AND indexname IN
        ('idx_document_chunk_embedding', 'idx_document_chunk_search', 'idx_document_chunk_geom',
         'idx_document_chunk_ordinal', 'idx_controlled_document_retrieval')) <> 5 THEN
        RAISE EXCEPTION 'knowledge indexes missing';
    END IF;
END $$;
ROLLBACK;
